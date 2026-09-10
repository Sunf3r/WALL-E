// Bucket classification from Telegram - buttons + commands.
//
// The new-chat prompt carries Personal/Business buttons; the tap resolves
// the chat through the stored prompt message ID and runs the same move
// the /personal and /business topic commands use. Commands stay as the
// fallback (deleted prompt, API hiccup, reclassification). The move runs
// detached - a 100-message replay outlasts Telegram's callback window, so
// the tap is acknowledged first and the prompt message edited on finish.
import { bucketOfChat, type GroupIds } from '../wa-to-tg/routing.ts'
import { moveTopic } from '../wa-to-tg/move.ts'
import type { BridgeDB } from '../db.ts'
import type { Bot } from 'grammy'

type Bucket = 'personal' | 'business'

const LABEL: Record<Bucket, string> = { personal: 'Personal', business: 'Business' }

export function registerBucketHandlers(tg: Bot, db: BridgeDB, groups: GroupIds): void {
	tg.callbackQuery(/^bucket:(personal|business)$/, async (ctx) => {
		try {
			const chatId = String(ctx.chat?.id ?? '')
			if (bucketOfChat(chatId, groups) === null) {
				await ctx.answerCallbackQuery({ text: 'Unknown group.' }).catch(() => null)
				return
			}
			const bucket = (ctx.match?.[1] === 'business' ? 'business' : 'personal') as Bucket
			const promptId = (ctx.callbackQuery?.message as { message_id?: number } | undefined)
				?.message_id
			if (!promptId) {
				await ctx.answerCallbackQuery({ text: 'Use /personal or /business in the topic.' })
					.catch(() => null)
				return
			}
			const mapping = db.getByPrompt(chatId, promptId)
			if (!mapping) {
				await ctx.answerCallbackQuery({
					text: 'Chat not found - use /personal or /business.',
				})
					.catch(() => null)
				return
			}
			if (mapping.bucket === bucket) {
				await ctx.answerCallbackQuery({ text: `Already in ${LABEL[bucket]}.` }).catch(() =>
					null
				)
				return
			}
			await ctx.answerCallbackQuery({ text: `Moving to ${LABEL[bucket]}…` }).catch(() => null)
			void classifyChat(db, tg, mapping.whatsapp_jid, bucket, chatId, promptId).catch((e) =>
				console.error('[BRIDGE] bucket classification failed:', e)
			)
		} catch (e) {
			console.error('[BRIDGE] bucket button failed:', e)
		}
	})

	for (const bucket of ['personal', 'business'] as Bucket[]) {
		tg.command(bucket, async (ctx) => {
			try {
				const chatId = String(ctx.chat?.id ?? '')
				if (bucketOfChat(chatId, groups) === null) return
				const topicId = (ctx.msg as any)?.message_thread_id
				if (!topicId) return
				const mapping = db.getByTopic(chatId, topicId)
				if (!mapping) {
					await ctx.reply('No bridged chat in this topic.')
					return
				}
				if (mapping.bucket === bucket) {
					await ctx.reply(`Already in ${LABEL[bucket]}.`)
					return
				}
				await ctx.reply(`Moving to ${LABEL[bucket]}…`)
				void classifyChat(db, tg, mapping.whatsapp_jid, bucket, chatId, null).catch((e) =>
					console.error('[BRIDGE] bucket command failed:', e)
				)
			} catch (e) {
				console.error(`[BRIDGE] /${bucket} failed:`, e)
			}
		})
	}
}

// Shared classify path: move, then retire the prompt (buttons) in the old
// topic. Failures land on the prompt when there is one, else as a reply.
async function classifyChat(
	db: BridgeDB,
	tg: Bot,
	jid: string,
	bucket: Bucket,
	chatId: string,
	promptId: number | null,
): Promise<void> {
	try {
		const result = await moveTopic(jid, bucket)
		if (!result) throw new Error('move returned no result')
		if (!result.moved) {
			if (promptId) {
				await tg.api.editMessageText(
					chatId,
					promptId,
					`Already in ${LABEL[bucket]}.`,
				).catch(() => null)
			}
			return
		}
		const done = bucket === 'business'
			? `✅ Business - fresh topic opened.`
			: `✅ Personal - replayed ${result.copied} message${result.copied === 1 ? '' : 's'}` +
				(result.skipped > 0 ? ` (${result.skipped} skipped)` : '') + '.'
		if (promptId) {
			await tg.api.editMessageText(chatId, promptId, done).catch(() => null)
		}
	} catch (e) {
		console.error('[BRIDGE] classify chat failed:', e)
		const line = `⚠️ Move to ${LABEL[bucket]} failed - try /${bucket} again.`
		if (promptId) {
			await tg.api.editMessageText(chatId, promptId, line).catch(() => null)
		} else {
			const mapping = db.getByJidOrAlias(jid)
			if (mapping) {
				await tg.api.sendMessage(chatId, line, {
					message_thread_id: mapping.telegram_topic_id,
				}).catch(() => null)
			}
		}
	}
}
