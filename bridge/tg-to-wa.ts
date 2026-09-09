// Telegram -> WhatsApp relay - facade wiring submodules.
// Sends through the shared WhatsApp socket - thin entry re-exporting API.
import { registerTgEditHandler, registerTgReactionHandler } from './tg-to-wa/handler-events.ts'
import { registerTgMessageHandler } from './tg-to-wa/handlers.ts'
import { registerTgCommands } from './tg-to-wa/commands.ts'
import type { RateLimiter } from './rate-limiter.ts'
import { formatBytes } from './format.ts'
import type { BridgeDB } from './db.ts'
import type { Bot } from 'grammy'

export { formatBytes }
export { buildWaContent, restoreWaKey, tgReactionToWaEmoji } from './tg-to-wa/content.ts'
export { convertWebmToStickerWebp, tgDownloadFailureLine } from './tg-to-wa/replies.ts'
export { TG_DOWNLOAD_CAP_BYTES } from './tg-to-wa/media.ts'
export type { TgDownload } from './tg-to-wa/media.ts'

export function registerTgHandlers(
	tg: Bot,
	db: BridgeDB,
	tgLimiter: RateLimiter,
	waLimiter: RateLimiter,
): void {
	const supergroupId = String(Deno.env.get('TELEGRAM_SUPERGROUP_ID'))
	const inSupergroup = (ctx: { chat?: { id?: string | number } }): boolean =>
		String(ctx.chat?.id) === supergroupId
	const waSend = <T>(fn: () => Promise<T>): Promise<T> => waLimiter.enqueue(fn, 'wa-send')
	registerTgCommands(
		tg,
		db,
		(fn, label) => tgLimiter.enqueue(fn, label),
		inSupergroup,
		supergroupId,
	)
	registerTgReactionHandler(tg, db, waSend, supergroupId)
	registerTgMessageHandler(tg, db, tgLimiter, waSend, supergroupId)
	registerTgEditHandler(tg, db, waSend, supergroupId)
}
