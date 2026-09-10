// Album flush worker - buffers photo bursts into media groups.
//
// Photos/videos wait out ALBUM_WINDOW_MS so rapid bursts cross as one
// Telegram media group instead of N singles - any other message flushes the
// pending group first so chat order is preserved, singletons fall back to
// the normal send path.
import { ALBUM_WINDOW_MS, albumKey, MAX_ALBUM_ITEMS, pendingAlbums } from './album.ts'
import { extOf, storedEntities, storedText } from './media-utils.ts'
import { notifyTopic, relayCtx, shortErr, tgCall } from './state.ts'
import type { AlbumItem } from './album.ts'
import { sendToTopic } from './send.ts'
import type { proto } from 'baileys'
import { InputFile } from 'grammy'

export function bufferAlbumItem(jid: string, m: proto.IWebMessageInfo, item: AlbumItem): void {
	const key = albumKey(jid, m)
	const existing = pendingAlbums.get(key)
	if (existing) {
		if (existing.items.length >= MAX_ALBUM_ITEMS) {
			void flushAlbum(key).catch((e) => console.error('[BRIDGE] album flush failed:', e))
		} else {
			existing.items.push(item)
			return
		}
	}
	const timer = setTimeout(() => {
		void flushAlbum(key).catch((e) => console.error('[BRIDGE] album flush failed:', e))
	}, ALBUM_WINDOW_MS)
	pendingAlbums.set(key, { items: [item], timer })
}

// Flush every pending album group of a chat (called before a non-eligible
// message sends, preserving chat order).
export async function flushPendingAlbums(jid: string): Promise<void> {
	const keys = [...pendingAlbums.keys()].filter((k) => k.startsWith(`${jid}\n`))
	for (const key of keys) await flushAlbum(key)
}

export async function flushAlbum(key: string): Promise<void> {
	const entry = pendingAlbums.get(key)
	if (!entry) return
	pendingAlbums.delete(key)
	clearTimeout(entry.timer)
	const { items } = entry
	const { db, limiter, tg } = relayCtx
	if (items.length === 0 || !db || !limiter || !tg) return
	const jid = key.split('\n')[0]
	const mapping = db.getByJidOrAlias(jid)
	if (!mapping || mapping.archived || mapping.muted) return
	const chatId = mapping.telegram_chat_id || relayCtx.groups.personal

	if (items.length === 1) {
		const it = items[0]
		await sendToTopic(
			it.topicId,
			it.chatId || chatId,
			it.body,
			it.entities,
			it.media,
			null,
			jid,
			it.m,
			{
				tgId: it.replyToTgId,
				header: null,
			},
		).catch((e) => console.error('[BRIDGE] failed to relay album singleton:', e))
		return
	}

	// Telegram caps media groups at 10 - chunk larger bursts.
	for (let c = 0; c < items.length; c += 10) {
		const chunk = items.slice(c, c + 10)
		const first = chunk[0]
		try {
			const inputMedia = chunk.map((it, i) => {
				const file = new InputFile(
					it.media.buffer,
					it.media.fileName || `file.${extOf(it.media)}`,
				)
				const captioned: Record<string, unknown> = i === 0 && first.body
					? { caption: first.body.slice(0, 1024) }
					: {}
				if (i === 0 && first.body && first.entities.length > 0) {
					captioned.caption_entities = first.entities
				}
				// GIFs ride as plain videos inside media groups (the Bot
				// API has no animation group item).
				return it.media.kind === 'image'
					? { type: 'photo', media: file, ...captioned }
					: { type: 'video', media: file, ...captioned }
			})
			const reply = first.replyToTgId
				? {
					reply_parameters: {
						message_id: first.replyToTgId,
						allow_sending_without_reply: true,
					},
				}
				: undefined
			const sentArr = await tgCall(
				() =>
					tg!.api.sendMediaGroup(chatId, inputMedia as any, {
						message_thread_id: first.topicId,
						...reply,
					}),
				'media-group',
			) as { message_id: number }[]
			sentArr.forEach((s, i) => {
				const it = chunk[i]
				if (s && it) {
					db!.saveReplyMap(
						s.message_id,
						jid,
						it.m.key?.id || '',
						JSON.stringify(it.m.key || {}),
						'media',
						storedText(it.body),
						storedEntities(it.entities),
						{ chatId, replyTo: first.replyToTgId },
					)
				}
			})
			// Captions beyond the first don't fit in a media group -
			// deliver them as one follow-up instead of dropping them.
			const extras = chunk.slice(1).map((it) => it.body).filter((b) => b)
			if (extras.length > 0) {
				const followBody = extras.join('\n')
				const sent = await tgCall(() =>
					tg!.api.sendMessage(chatId, followBody, {
						message_thread_id: first.topicId,
					}), 'message')
				const last = chunk[chunk.length - 1]
				db!.saveReplyMap(
					sent.message_id,
					jid,
					last.m.key?.id || '',
					JSON.stringify(last.m.key || {}),
					'text',
					storedText(followBody),
					null,
					{ chatId },
				)
			}
		} catch (e) {
			console.error('[BRIDGE] failed to relay album group:', e)
			await notifyTopic(
				chatId,
				first.topicId,
				`⚠️ Couldn't relay a photo group (${chunk.length} photos): ${shortErr(e)}`,
			)
		}
	}
}
