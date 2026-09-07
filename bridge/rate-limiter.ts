// Outgoing queue for Telegram Bot API calls.
//
// Telegram throttles per-chat (roughly 1 msg/s, ~20 msg/min per group) and
// all forum topics share the same underlying supergroup chat, so ALL
// tg.api.* calls go through ONE global FIFO queue with `limitMs` spacing
// between individual API calls (not per logical message — one logical send
// can be 2-3 API calls: header + sticker, content + follow-up, …).
//
// Flood handling: when Telegram answers 429, the failing item is retried
// (bounded) after the server's `retry_after`, and the whole queue pauses for
// that duration. Without this, every subsequent send also 429s (cascade) and
// messages are silently dropped.
export interface RateLimiterOptions {
	/** Max retries of the same item after a 429. Default 5. */
	maxRetries?: number
	/** Cap for a single flood wait. Default 120_000 ms. */
	maxWaitMs?: number
	/** Fallback wait when a 429 carries no retry_after. Default 5_000 ms. */
	defaultRetryAfterMs?: number
	/** Extra buffer added on top of the server's retry_after. Default 500 ms. */
	retryBufferMs?: number
}

// Extract Telegram's "retry after N seconds" from a GrammyError (or any
// error shaped like one). Returns seconds, or null when this is not a 429.
export function getRetryAfterSeconds(e: unknown): number | null {
	try {
		const anyErr = e as {
			error_code?: unknown
			parameters?: { retry_after?: unknown }
			description?: unknown
		}
		if (anyErr && anyErr.error_code === 429) {
			const ra = anyErr.parameters?.retry_after
			if (typeof ra === 'number' && Number.isFinite(ra) && ra >= 0) return ra
			// Fallback: parse "retry after N" out of the description.
			const desc = typeof anyErr.description === 'string' ? anyErr.description : ''
			const m = /retry after (\d+)/i.exec(desc)
			if (m) return Number(m[1])
			return 0 // 429 without a usable value — caller applies default wait.
		}
	} catch {
		// fall through to null
	}
	return null
}

interface QueueItem {
	fn: () => Promise<unknown>
	resolve: (v: unknown) => void
	reject: (e: unknown) => void
	attempts: number
	label: string
}

export class RateLimiter {
	private limitMs: number
	private maxRetries: number
	private maxWaitMs: number
	private defaultRetryAfterMs: number
	private retryBufferMs: number
	private queue: QueueItem[] = []
	private running = false
	private lastRun = 0
	private blockedUntil = 0

	constructor(limitMs: number = 3000, opts: RateLimiterOptions = {}) {
		this.limitMs = limitMs
		this.maxRetries = opts.maxRetries ?? 5
		this.maxWaitMs = opts.maxWaitMs ?? 120_000
		this.defaultRetryAfterMs = opts.defaultRetryAfterMs ?? 5_000
		this.retryBufferMs = opts.retryBufferMs ?? 500
	}

	enqueue<T>(fn: () => Promise<T>, label = 'send'): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				fn: fn as () => Promise<unknown>,
				resolve: resolve as (v: unknown) => void,
				reject,
				attempts: 0,
				label,
			})
			void this.drain()
		})
	}

	/** Number of items waiting (including the in-flight one). */
	get depth(): number {
		return this.queue.length
	}

	private async drain(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			while (this.queue.length > 0) {
				const now = Date.now()
				const wait = Math.max(
					this.limitMs - (now - this.lastRun),
					this.blockedUntil - now,
				)
				if (wait > 0) await new Promise((r) => setTimeout(r, wait))
				const item = this.queue.shift()!
				try {
					item.resolve(await item.fn())
					this.lastRun = Date.now()
				} catch (e) {
					const retryAfter = getRetryAfterSeconds(e)
					if (retryAfter !== null && item.attempts < this.maxRetries) {
						item.attempts += 1
						const baseMs = retryAfter > 0 ? retryAfter * 1000 : this.defaultRetryAfterMs
						const waitMs = Math.min(baseMs + this.retryBufferMs, this.maxWaitMs)
						this.blockedUntil = Date.now() + waitMs
						// Requeue at the FRONT to preserve global FIFO order —
						// later items must not overtake the failed one.
						this.queue.unshift(item)
						console.warn(
							`[BRIDGE] Telegram flood control: retry after ${
								(waitMs / 1000).toFixed(1)
							}s ` +
								`(attempt ${item.attempts}/${this.maxRetries}, op=${item.label}, ` +
								`queue=${this.queue.length})`,
						)
					} else {
						if (retryAfter !== null) {
							console.error(
								`[BRIDGE] queued ${item.label} failed: giving up after ${item.attempts} ` +
									`flood retries, dropping it:`,
								e,
							)
						} else {
							console.error(`[BRIDGE] queued ${item.label} failed:`, e)
						}
						this.lastRun = Date.now()
						item.reject(e)
					}
				}
			}
		} finally {
			this.running = false
		}
	}
}
