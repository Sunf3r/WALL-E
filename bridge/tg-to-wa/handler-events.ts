// Telegram reaction and edit handlers - lightweight event paths.
// Split from handlers.ts so each file stays under the size budget.
import { restoreWaKey, tgReactionToWaEmoji } from './content.ts'
import { tgEntitiesToWa } from '../format.ts'
import type { BridgeDB } from '../db.ts'
import type { Bot } from 'grammy'
import bot from '@plugin/bot.ts'

type WaSend = <T>(fn: () => Promise<T>) => Promise<T>

export function registerTgReactionHandler(
	tg: Bot,
	db: BridgeDB,
	waSend: WaSend,
	supergroupId: string,
): void {
	tg.on('message_reaction', async (ctx) => {
		try {
			const upd: any = ctx.update.message_reaction
			if (!upd || String(upd.chat?.id) !== supergroupId) return
			if (upd.user?.is_bot || !upd.message_id) return
			const entry = db.getReplyMap(upd.message_id)
			if (!entry || db.getByJid(entry.wa_jid)?.muted) return
			const key = restoreWaKey(entry)
			if (!key) return
			const emoji = tgReactionToWaEmoji(upd.old_reaction, upd.new_reaction)
			db.markTgReact(entry.wa_jid, entry.wa_msg_id, emoji)
			await waSend(() => bot.sock.sendMessage(entry.wa_jid, { react: { text: emoji, key } }))
		} catch (e) {
			console.error('[BRIDGE] TG->WA reaction failed:', e)
		}
	})
}

export function registerTgEditHandler(
	tg: Bot,
	db: BridgeDB,
	waSend: WaSend,
	supergroupId: string,
): void {
	tg.on('edited_message', async (ctx) => {
		try {
			const msg: any = ctx.editedMessage
			if (!msg || String(ctx.chat.id) !== supergroupId || msg.from?.is_bot) return
			const topicId = msg.message_thread_id
			if (!topicId) return
			const mapping = db.getByTopicId(topicId)
			if (!mapping || mapping.archived || mapping.muted) return
			const rawText = msg.text || msg.caption || ''
			const text = tgEntitiesToWa(rawText, msg.entities || msg.caption_entities).trim()
			if (!text) return
			const entry = db.getReplyMap(msg.message_id)
			if (!entry) return
			const key = restoreWaKey(entry)
			if (!key) return
			db.markTgEdit(mapping.whatsapp_jid, entry.wa_msg_id)
			await waSend(async () => {
				await bot.sock.sendMessage(mapping.whatsapp_jid, { text, edit: key })
				db.updateLastActive(mapping.whatsapp_jid)
			})
		} catch (e) {
			console.error('[BRIDGE] TG->WA edit failed:', e)
		}
	})
}
