// Outgoing queue: Telegram allows ~1 msg/sec into the same chat, and all
// forum topics share the same underlying supergroup chat, so we use ONE
// global FIFO queue with `limitMs` spacing between sends (not per-topic).
const MAX_QUEUE = 200
const MIN_LIMIT_MS = 200

export class RateLimiter {
	private limitMs: number
	private queue: Array<
		{ fn: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }
	> = []
	private running = false
	private lastRun = 0

	constructor(limitMs: number = 1000) {
		this.limitMs = Number.isFinite(limitMs) && limitMs >= MIN_LIMIT_MS ? limitMs : 1000
	}

	enqueue<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this.queue.length >= MAX_QUEUE) {
				reject(new Error('bridge queue is full, try again later'))
				return
			}
			this.queue.push({
				fn: fn as () => Promise<unknown>,
				resolve: resolve as (v: unknown) => void,
				reject,
			})
			void this.drain()
		})
	}

	private async drain(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			while (this.queue.length > 0) {
				const wait = this.limitMs - (Date.now() - this.lastRun)
				if (wait > 0) await new Promise((r) => setTimeout(r, wait))
				const item = this.queue.shift()!
				try {
					item.resolve(await item.fn())
				} catch (e) {
					console.error('[BRIDGE] queued send failed:', e)
					item.reject(e)
				}
				this.lastRun = Date.now()
			}
		} finally {
			this.running = false
		}
	}
}
