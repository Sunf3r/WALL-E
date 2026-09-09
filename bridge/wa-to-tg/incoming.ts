// Incoming WA message relay - main upsert loop in one place.
//
// Skips protocol and reaction carriers plus TG echoes, ensures a forum topic
// mapping, degrades unmappable specials to text and routes photos through
// album batching - quote resolution, empty notices and mapping live in
// chat/quote/unsupported helpers so this loop stays small.
import { annotateMentions, getMentionedJids, getMsgText, phoneOf } from './text.ts'
import { bufferAlbumItem, flushPendingAlbums } from './album-flush.ts'
import { ensureTopicMapping } from './topics.ts'
import { resolveChatName } from './chat.ts'
import { notifyTopic, relayCtx, shortErr } from './state.ts'
import { waMarkdownToTgEntities } from '../format.ts'
import { canonicalChatJid } from './jid.ts'
import { notifyEmptyRelay } from './unsupported.ts'
import { getSpecialContent } from './special.ts'
import { resolveQuoteTarget } from './quote.ts'
import { isAlbumEligible } from './album.ts'
import { downloadWaMedia } from './media.ts'
import { findKey } from '@util/functions.ts'
import { sendToTopic } from './send.ts'
import type { proto } from 'baileys'

export async function handleWAMessages(messages: proto.IWebMessageInfo[]) {
	const { db, limiter, tg } = relayCtx
	if (!db || !limiter || !tg) return

	for (const m of messages) {
		let topicId: number | null = null
		try {
			if (!m?.message || !m.key) continue
			// Skip protocol traffic (deletes, history sync, ...) and reaction
			// carriers: Baileys delivers every reaction BOTH as messages.upsert
			// with reactionMessage content AND as messages.reaction. The
			// carrier's reactionMessage.text is the emoji itself, which
			// getMsgText would otherwise relay as a bogus "You: ❤️" message -
			// reactions travel via handleWaReactions only.
			if (findKey(m.message, 'protocolMessage')) continue
			if (findKey(m.message, 'reactionMessage')) continue

			const rawJid = m.key.remoteJid
			if (!rawJid || rawJid === 'status@broadcast') continue
			// Canonicalize LID/PN variants to one chat before any mapping
			// lookup, so one person never splits across two topics.
			const { canonical: jid, aliases } = await canonicalChatJid(m.key)
			if (!jid) continue
			// Own messages: TG-TO-WA sends re-emit here with fromMe=true. Those
			// are already in reply_map, so skip them - but messages sent from
			// the phone/client are new (unmapped) and mirror with a `You:`
			// label. The map check doubles as redelivery dedupe.
			const echo = m.key.fromMe && !!m.key.id &&
				!!db.getByWaMsgIdAny(m.key.id, [jid, ...aliases])
			if (echo) continue
			const isGroup = jid.endsWith('@g.us')
			const chatType: '1:1' | 'group' = isGroup ? 'group' : '1:1'
			const fromMe = !!m.key.fromMe

			const displayName = await resolveChatName(jid, m.pushName, isGroup, fromMe)
			const senderName = m.key.fromMe
				? 'You'
				: (isGroup ? (m.pushName || phoneOf(m.key.participant) || 'unknown') : displayName)

			const ensured = await ensureTopicMapping(jid, displayName, chatType, isGroup, {
				canRename: !fromMe,
				aliases,
			})
			if (!ensured) continue
			topicId = ensured.topicId
			// Local number-typed alias: the outer topicId stays nullable for
			// the catch-block notify, but everything below needs a number.
			const tid: number = topicId

			let text = annotateMentions(getMsgText(m.message), getMentionedJids(m))
			const dl = await downloadWaMedia(m)
			const media = dl?.media ?? null
			let special = getSpecialContent(m.message)
			// Content Telegram can't represent natively degrades to text
			// BEFORE entity parsing, so formatting offsets stay consistent.
			if (special?.kind === 'poll' && special.options.filter((o) => o.trim()).length < 2) {
				const opts = special.options.join('\n')
				text = `📊 ${special.question}${opts ? '\n' + opts : ''}${text ? '\n' + text : ''}`
				special = null
			}
			if (special?.kind === 'contact' && !special.phone) {
				text = `👤 ${special.name || 'Contact'}${text ? '\n' + text : ''}`
				special = null
			}

			if (!text && !media && !special) {
				if (topicId !== null) await notifyEmptyRelay(topicId, dl, m, senderName)
				continue
			}

			// WhatsApp quote -> Telegram reply via shared helper.
			const { replyToTgId, quoteHeader } = resolveQuoteTarget(
				db,
				jid,
				m,
				displayName,
				aliases,
			)

			const label = m.key.fromMe ? 'You: ' : (isGroup ? `${senderName}: ` : '')
			// WhatsApp inline markers -> Telegram entities. The sender label
			// (and quote header) are plain text, so entity offsets shift past
			// them. Stickers take no caption, so their fallback header still
			// travels separately via `quote.header` (sent as its own message).
			const stickerFallback = media?.kind === 'sticker' && !!quoteHeader && !replyToTgId
			const parsed = waMarkdownToTgEntities(text)
			const prefix = `${!stickerFallback && quoteHeader ? quoteHeader + '\n' : ''}${label}`
			const body = `${prefix}${parsed.text}`
			const entities = parsed.entities.map((e) => ({
				...e,
				offset: e.offset + prefix.length,
			}))
			// Unmapped originals can't use reply_parameters - render the
			// fallback header as a real Telegram quote block instead.
			if (!stickerFallback && quoteHeader) {
				entities.unshift({ type: 'blockquote', offset: 0, length: quoteHeader.length })
			}
			if (isAlbumEligible(media, special, body)) {
				// Photos/videos wait out the album window so rapid bursts
				// cross as one Telegram media group instead of N singles.
				bufferAlbumItem(jid, m, {
					m,
					topicId: tid,
					body,
					entities,
					media,
					replyToTgId,
				})
			} else {
				// Anything else flushes pending albums first so chat order
				// is preserved, then sends immediately as before.
				// sendToTopic enqueues each Telegram API call on the
				// limiter itself, so this awaits delivery (with flood
				// retries) instead of just queueing.
				await flushPendingAlbums(jid)
				await sendToTopic(tid, body, entities, media, special, jid, m, {
					tgId: replyToTgId,
					header: stickerFallback ? quoteHeader : null,
				})
			}
		} catch (e) {
			console.error('[BRIDGE] failed to relay one WA message:', e)
			if (topicId !== null) {
				await notifyTopic(topicId, `⚠️ Couldn't relay a WhatsApp message: ${shortErr(e)}`)
			}
		}
	}
}
