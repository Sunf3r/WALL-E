// Bridge entry point.
//
// Two ways to use it:
//
// 1. Embedded (normal): wa.ts calls `startBridge()` AFTER bot.connect() +
//    loadEvents(). The bridge shares the running WhatsApp socket - no second
//    connection, no auth duplication.
// 2. Standalone helper: `deno run -A bridge/mod.ts -- --find-id` prints the
//    supergroup ID so you can put it in conf/.env. This mode never touches
//    WhatsApp.
import { registerTgHandlers } from './tg-to-wa.ts'
import { RateLimiter } from './rate-limiter.ts'
import { attachWaRelay } from './wa-to-tg.ts'
import { BridgeDB } from './db.ts'
import { Bot } from 'grammy'

export async function findSupergroupId(): Promise<void> {
	const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
	if (!token) {
		console.error('Missing TELEGRAM_BOT_TOKEN in env')
		Deno.exit(1)
	}

	const bot = new Bot(token)
	const updates = await bot.api.getUpdates({ limit: 100 })

	for (const update of updates as any[]) {
		const chat = update.message?.chat || update.edited_message?.chat ||
			update.channel_post?.chat
		if (chat && (chat.type === 'supergroup' || chat.type === 'group')) {
			console.log(`\nSupergroup ID: \`${chat.id}\`\n`)
			console.log(`Copy this ID and set it as TELEGRAM_SUPERGROUP_ID in conf/.env.`)
			console.log(`Chat title: ${chat.title || 'N/A'}`)
			console.log(`Is forum: ${chat.is_forum || false}`)
			Deno.exit(0)
		}
	}

	console.log('No supergroup found in recent updates.')
	console.log('Make sure the bot is added to the supergroup and send a message there first.')
}

// Starts the Telegram side and hooks the WA→TG relay onto the shared socket.
// Returns null (instead of throwing) when not configured, so the WhatsApp
// bot always boots even if the bridge env is missing.
let activeBridge: { tg: Bot; db: BridgeDB; tgLimiter: RateLimiter; waLimiter: RateLimiter } | null =
	null

export function reattachBridge(): void {
	if (!activeBridge) return
	attachWaRelay(activeBridge.tg, activeBridge.db, activeBridge.tgLimiter)
}

export function startBridge(): Bot | null {
	const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
	const supergroupId = Deno.env.get('TELEGRAM_SUPERGROUP_ID')

	if (!token || !supergroupId) {
		console.log(
			'[BRIDGE] disabled: set TELEGRAM_BOT_TOKEN and TELEGRAM_SUPERGROUP_ID to enable',
		)
		return null
	}

	const db = new BridgeDB('conf/gen/bridge.db')
	db.init()
	// Telegram and WhatsApp have independent budgets, so they get independent
	// queues. All forum topics share ONE supergroup, whose flood control is
	// stricter than 1 msg/s (~20/min per group + burst penalties with
	// retry_after up to tens of seconds), hence the conservative 3s default.
	// TELEGRAM_RATE_LIMIT_MS overrides the legacy RATE_LIMIT_MS name.
	const tgLimiter = new RateLimiter(
		envNum('TELEGRAM_RATE_LIMIT_MS', envNum('RATE_LIMIT_MS', 3000)),
		{
			maxRetries: envNum('RATE_LIMIT_MAX_RETRIES', 5),
			maxWaitMs: envNum('RATE_LIMIT_MAX_WAIT_MS', 120_000),
		},
	)
	// WhatsApp sends don't consume Telegram budget - light spacing only, so a
	// Telegram flood never stalls the TG→WA direction (and vice versa).
	const waLimiter = new RateLimiter(envNum('WHATSAPP_RATE_LIMIT_MS', 500))

	const tg = new Bot(token)
	registerTgHandlers(tg, db, tgLimiter, waLimiter)
	// The WA socket is already connected by wa.ts at this point.
	attachWaRelay(tg, db, tgLimiter)
	activeBridge = { tg, db, tgLimiter, waLimiter }

	tg.catch((e) => console.error('[BRIDGE] Telegram handler error:', e))
	// Fire-and-forget: bot.start() long-polls until stopped; never await it
	// here or wa.ts would never finish booting.
	//
	// allowed_updates MUST list message_reaction explicitly: Telegram excludes
	// it (with chat_member and message_reaction_count) from the default set,
	// so without this the TG→WA reaction handler never fires - silently.
	// The bot must also be an administrator in the supergroup, otherwise
	// Telegram withholds these updates too (checked below, non-fatal warn).
	tg.start({
		allowed_updates: ['message', 'edited_message', 'message_reaction'],
	}).catch((e) => console.error('[BRIDGE] Telegram polling stopped:', e))
	void checkReactionPrereqs(tg, supergroupId)

	console.log('[BRIDGE] running: WhatsApp <-> Telegram topic mirror active')
	return tg
}

// Parse a numeric env var with a safe fallback (unset, empty, NaN and
// negatives all fall back - a 0/negative spacing would defeat the queue).
function envNum(name: string, fallback: number): number {
	const raw = Deno.env.get(name)
	if (raw == null || raw.trim() === '') return fallback
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? n : fallback
}

// Non-blocking sanity check: reacting on Telegram only reaches the bridge
// when the bot is an admin of the supergroup. Warns once instead of failing
// the boot - messaging works fine without it, reactions just stay silent.
async function checkReactionPrereqs(tg: Bot, supergroupId: string): Promise<void> {
	try {
		const me = await tg.api.getMe()
		const member = await tg.api.getChatMember(supergroupId, me.id).catch(() => null) as
			| { status?: string }
			| null
		if (member && member.status !== 'administrator' && member.status !== 'creator') {
			console.warn(
				`[BRIDGE] Telegram reactions need the bot to be an administrator of the supergroup (currently: ${member.status}). ` +
					'TG→WA reactions will not arrive until it is promoted.',
			)
		}
	} catch {
		// Prereq check failed (network, permissions) - reactions just stay silent.
	}
}

if (import.meta.main) {
	if (Deno.args.includes('--find-id')) {
		await findSupergroupId()
	} else {
		console.error('This module runs embedded in the WhatsApp bot (see wa.ts).')
		console.error('Helper: deno run -A --env-file=conf/.env bridge/mod.ts -- --find-id')
		Deno.exit(1)
	}
}
