// Telegram command handlers - topic admin commands.
// All tg.command registrations - message handlers stay in facade.
import type { BridgeDB } from '../db.ts'
import bot from '@plugin/bot.ts'
import { Bot } from 'grammy'

export type TgCall = <T>(fn: () => Promise<T>, label?: string) => Promise<T>
export type InSupergroup = (ctx: { chat?: { id?: string | number } }) => boolean

export function registerTgCommands(
	tg: Bot,
	db: BridgeDB,
	tgCall: TgCall,
	inSupergroup: InSupergroup,
	supergroupId: string,
): void {
	tg.command('start', async (ctx) => {
		if (!inSupergroup(ctx)) return
		await ctx.reply('WhatsApp bridge is active. Each WhatsApp chat mirrors to its own topic.')
	})

	tg.command('id', async (ctx) => {
		await ctx.reply(
			`Supergroup ID: \`${ctx.chat.id}\`\nSet it as TELEGRAM_SUPERGROUP_ID in conf/.env.`,
			{ parse_mode: 'Markdown' },
		)
	})

	tg.command('topics', async (ctx) => {
		if (!inSupergroup(ctx)) return
		const topics = db.getAllActive()
		const msg = topics.map((t) =>
			`${t.display_name} (${t.whatsapp_jid}) -> topic #${t.telegram_topic_id}`
		).join('\n')
		await ctx.reply(msg || 'No active topics yet.')
	})

	tg.command('archive', async (ctx) => {
		if (!inSupergroup(ctx)) return
		const topicId = (ctx.msg as any)?.message_thread_id
		if (!topicId) return
		const mapping = db.getByTopicId(topicId)
		if (mapping) {
			db.archive(mapping.whatsapp_jid)
			await ctx.reply(`Archived bridge for ${mapping.display_name} (mapping kept)`)
		}
	})

	// Alias kept for backwards compatibility.
	tg.command('close', async (ctx) => {
		if (!inSupergroup(ctx)) return
		const topicId = (ctx.msg as any)?.message_thread_id
		if (!topicId) return
		const mapping = db.getByTopicId(topicId)
		if (mapping) {
			db.archive(mapping.whatsapp_jid)
			await ctx.reply(`Closed bridge for ${mapping.display_name} (mapping kept)`)
		}
	})

	tg.command('reopen', async (ctx) => {
		if (!inSupergroup(ctx)) return
		const topicId = (ctx.msg as any)?.message_thread_id
		if (!topicId) return
		const all = db.getAll().find((t) => t.telegram_topic_id === topicId)
		if (all) {
			db.unarchive(all.whatsapp_jid)
			await ctx.reply(`Reopened bridge for ${all.display_name}`)
		}
	})

	// Per-chat mute: /mute stops relay in both directions for this topic
	// (mapping kept, history untouched); /unmute resumes.
	tg.command('mute', async (ctx) => {
		if (!inSupergroup(ctx)) return
		const topicId = (ctx.msg as any)?.message_thread_id
		if (!topicId) return
		const mapping = db.getByTopicId(topicId)
		if (mapping) {
			db.setMuted(mapping.whatsapp_jid, true)
			await ctx.reply(`Muted ${mapping.display_name} - nothing relays until /unmute.`)
		}
	})

	tg.command('unmute', async (ctx) => {
		if (!inSupergroup(ctx)) return
		const topicId = (ctx.msg as any)?.message_thread_id
		if (!topicId) return
		// Muted mappings are still returned by getByTopicId (only archived
		// ones are filtered), so this resolves the same row /mute set.
		const mapping = db.getByTopicId(topicId)
		if (mapping) {
			db.setMuted(mapping.whatsapp_jid, false)
			await ctx.reply(`Unmuted ${mapping.display_name} - relay resumed.`)
		}
	})

	// Start a bridged chat from the Telegram side: `/new <phone> [name]`.
	// Verifies the number on WhatsApp, creates the forum topic + mapping -
	// the first message written in that topic relays like any other.
	tg.command('new', async (ctx) => {
		try {
			if (String(ctx.chat.id) !== supergroupId) return
			if (ctx.from?.is_bot) return
			const args = ((ctx.match as string) || '').trim().split(/\s+/)
			const digits = (args[0] || '').replace(/\D/g, '')
			if (!digits || digits.length < 7 || digits.length > 15) {
				await ctx.reply(
					'Usage: /new <phone number> [name]\nExample: /new 15551234567 Alice',
				)
				return
			}
			const jid = `${digits}@s.whatsapp.net`
			const existing = db.getByJidOrAlias(jid)
			if (existing && !existing.archived) {
				await ctx.reply(
					`+${digits} is already bridged in topic #${existing.telegram_topic_id}.`,
				)
				return
			}
			const lookup = await bot.sock.onWhatsApp(jid).catch((): {
				jid: string
				exists: boolean
			}[] => [])
			const info = lookup?.[0]
			if (!info?.exists) {
				await ctx.reply(`No WhatsApp account found for +${digits}.`)
				return
			}
			// The server may address this contact under a LID elsewhere -
			// remember the verified JID as an alias of the canonical PN.
			try {
				const { normalizeJid } = await import('../wa-to-tg/jid.ts')
				const verified = normalizeJid((info as { jid?: string }).jid)
				if (verified) db.addAlias(verified, jid)
			} catch {
				// Best effort - the WA side heals the alias on first sight.
			}
			const name = (args.slice(1).join(' ') || `+${digits}`).replace(/[\n\r]+/g, ' ').trim()
				.slice(0, 128) || `+${digits}`
			const topic = await tgCall(
				() => tg.api.createForumTopic(supergroupId, name),
				'new-topic',
			)
			db.getOrCreate(jid, topic.message_thread_id, name, '1:1')
			await ctx.reply(
				`Bridged +${digits} → topic #${topic.message_thread_id}. Write there to send.`,
			)
		} catch (e) {
			console.error('[BRIDGE] TG→WA /new failed:', e)
		}
	})
}
