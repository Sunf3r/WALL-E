// WhatsApp → Telegram relay.
//
// IMPORTANT: this module does NOT open its own WhatsApp connection. A second
// Baileys socket sharing the same auth state fights the main bot for the
// session (stream conflict / repeated logouts). Instead we piggyback on the
// already-running bot singleton from @plugin/bot.ts.
//
// Call `attachWaRelay()` AFTER `loadEvents()` in wa.ts — loadEvents() calls
// removeAllListeners() per event, so attaching earlier would wipe our hook.
import { downloadMediaMessage, type proto, WAMessageStubType } from 'baileys'
import { Bot, InputFile } from 'grammy'
import { findKey } from '@util/functions.ts'
import { logger } from '@util/proto.ts'
import bot from '@plugin/bot.ts'
import type { BridgeDB, MirrorKind, ReplyMapRow } from './db.ts'
import type { RateLimiter } from './rate-limiter.ts'
import { parseVcard, type TgEntity, waMarkdownToTgEntities } from './format.ts'

let tg: Bot | null = null
let db: BridgeDB | null = null
let limiter: RateLimiter | null = null
let supergroupId: string | number = ''
const groupNameCache = new Map<string, string>()

export function attachWaRelay(tgBot: Bot, bridgeDb: BridgeDB, rateLimiter: RateLimiter): void {
	tg = tgBot
	db = bridgeDb
	limiter = rateLimiter
	supergroupId = Deno.env.get('TELEGRAM_SUPERGROUP_ID')!

	// Additional listener on the SHARED socket — the core bot handler stays untouched.
	bot.sock.ev.on('messages.upsert', async (raw: { messages: proto.IWebMessageInfo[] }) => {
		try {
			await handleWAMessages(raw.messages)
		} catch (e) {
			console.error('[BRIDGE] WA→TG handler failed:', e)
		}
	})
	// Reactions ride a separate event on the same shared socket. Attached
	// here (after loadEvents) for the same removeAllListeners reason.
	bot.sock.ev.on(
		'messages.reaction',
		async (reactions: { key: proto.IMessageKey; reaction: proto.IReaction }[]) => {
			try {
				await handleWaReactions(reactions)
			} catch (e) {
				console.error('[BRIDGE] WA→TG reaction handler failed:', e)
			}
		},
	)
	// Edits arrive as `messages.update` (protocol MESSAGE_EDIT), not upsert —
	// the bridge previously ignored them, so WA edits never reached Telegram.
	bot.sock.ev.on(
		'messages.update',
		async (updates: { key: proto.IMessageKey; update: { message?: any } }[]) => {
			try {
				await handleWaEdits(updates)
			} catch (e) {
				console.error('[BRIDGE] WA→TG edit handler failed:', e)
			}
		},
	)
	// Group membership / subject changes → service lines in the topic.
	bot.sock.ev.on('group-participants.update', async (upd: any) => {
		try {
			await handleGroupParticipants(upd)
		} catch (e) {
			console.error('[BRIDGE] WA→TG group event failed:', e)
		}
	})
	// Local "delete for me" syncs → delete the Telegram mirror too.
	// "Delete for everyone" revokes arrive as `messages.update` (REVOKE stub)
	// and are handled in handleWaEdits; the Bot API emits no event when a
	// Telegram message is deleted, so TG→WA delete sync is impossible.
	bot.sock.ev.on('messages.delete', async (payload: any) => {
		try {
			await handleWaDeletes(payload)
		} catch (e) {
			console.error('[BRIDGE] WA→TG delete handler failed:', e)
		}
	})
	bot.sock.ev.on('groups.update', async (updates: Partial<{ id: string; subject: string }>[]) => {
		try {
			await handleGroupUpdates(updates)
		} catch (e) {
			console.error('[BRIDGE] WA→TG group update failed:', e)
		}
	})
	console.log('[BRIDGE] WA→TG relay attached to the shared WhatsApp socket')
}

async function handleWAMessages(messages: proto.IWebMessageInfo[]) {
	if (!db || !limiter || !tg) return

	for (const m of messages) {
		let topicId: number | null = null
		try {
			if (!m?.message || !m.key) continue
			// Skip protocol traffic (deletes, history sync, …) and reaction
			// carriers: Baileys delivers every reaction BOTH as messages.upsert
			// with reactionMessage content AND as messages.reaction. The
			// carrier's reactionMessage.text is the emoji itself, which
			// getMsgText would otherwise relay as a bogus "You: ❤️" message —
			// reactions travel via handleWaReactions only.
			if (findKey(m.message, 'protocolMessage')) continue
			if (findKey(m.message, 'reactionMessage')) continue

			const jid = m.key.remoteJid
			if (!jid || jid === 'status@broadcast') continue
			// Own messages: TG→WA sends re-emit here with fromMe=true. Those
			// are already in reply_map, so skip them — but messages sent from
			// the phone/client are new (unmapped) and mirror with a `You:`
			// label. The map check doubles as redelivery dedupe.
			const echo = m.key.fromMe && !!m.key.id && !!db.getByWaMsgId(m.key.id, jid)
			if (echo) continue
			const isGroup = jid.endsWith('@g.us')
			const chatType: '1:1' | 'group' = isGroup ? 'group' : '1:1'

			const displayName = await resolveChatName(jid, m.pushName, isGroup)
			const senderName = m.key.fromMe
				? 'You'
				: (isGroup ? (m.pushName || phoneOf(m.key.participant) || 'unknown') : displayName)

			let mapping = db.getByJid(jid)
			if (!mapping || mapping.archived) {
				const freshTopicId = await createForumTopic(displayName, isGroup)
				mapping = db.getOrCreate(jid, freshTopicId, displayName, chatType)
				console.log(`[BRIDGE] new topic #${freshTopicId} for ${jid} (${displayName})`)
			} else {
				if (mapping.display_name !== displayName) {
					mapping = db.getOrCreate(jid, mapping.telegram_topic_id, displayName, chatType)
				} else {
					db.updateLastActive(jid)
				}
			}
			if (mapping.muted) {
				console.debug(`[BRIDGE] skipping WA message: ${jid} muted`)
				continue
			}
			topicId = mapping.telegram_topic_id
			// Local number-typed alias: the outer topicId stays nullable for
			// the catch-block notify, but everything below needs a number.
			const tid: number = topicId

			let text = annotateMentions(getMsgText(m.message), getMentionedJids(m))
			const media = await downloadWaMedia(m)
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
				// A media node whose download failed would otherwise vanish
				// silently — tell the topic instead of dropping it.
				if (hasDownloadableMedia(m) && topicId !== null) {
					await notifyTopic(
						topicId,
						`⚠️ Couldn't download a WhatsApp attachment — it didn't cross.`,
					)
				}
				continue
			}

			// WhatsApp quote → Telegram reply. Resolve the quoted stanzaId to
			// the Telegram message mirroring the original; when the original
			// was never bridged (history, pruned), fall back to a quote-styled
			// header (blockquote entity) so context isn't silently lost.
			const quote = getQuoteInfo(m, displayName)
			let replyToTgId: number | null = null
			let quoteHeader: string | null = null
			if (quote) {
				const target = db.getByWaMsgId(quote.stanzaId, jid)
				if (target) {
					replyToTgId = target.tg_msg_id
				} else {
					quoteHeader = `↩️ ${quote.author}: ${quote.preview}`
				}
			}

			const label = m.key.fromMe ? 'You: ' : (isGroup ? `${senderName}: ` : '')
			// WhatsApp inline markers → Telegram entities. The sender label
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
			// Unmapped originals can't use reply_parameters — render the
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
				await flushPendingAlbums(jid)
				await limiter.enqueue(() =>
					sendToTopic(tid, body, entities, media, special, jid, m, {
						tgId: replyToTgId,
						header: stickerFallback ? quoteHeader : null,
					})
				)
			}
		} catch (e) {
			console.error('[BRIDGE] failed to relay one WA message:', e)
			if (topicId !== null) {
				await notifyTopic(topicId, `⚠️ Couldn't relay a WhatsApp message: ${shortErr(e)}`)
			}
		}
	}
}

// Media album batching (WA→TG). Consecutive photos/videos from the same
// sender in one chat cross as a single Telegram media group instead of N
// disconnected messages. Every eligible message waits out ALBUM_WINDOW_MS;
// any other message in the chat flushes the pending group first so order
// is preserved. Singletons fall back to the normal sendToTopic path.
const ALBUM_WINDOW_MS = 1500

interface AlbumItem {
	m: proto.IWebMessageInfo
	topicId: number
	body: string
	entities: TgEntity[]
	media: { kind: string; buffer: Uint8Array; mime?: string; fileName?: string; ptt?: boolean }
	replyToTgId: number | null
}

const pendingAlbums = new Map<
	string,
	{ items: AlbumItem[]; timer: ReturnType<typeof setTimeout> }
>()

function albumKey(jid: string, m: proto.IWebMessageInfo): string {
	const sender = m.key?.fromMe ? 'me' : (m.key?.participant || m.pushName || 'other')
	return `${jid}\n${sender}`
}

export function isAlbumEligible(
	media:
		| { kind: string; buffer: Uint8Array; mime?: string; fileName?: string; ptt?: boolean }
		| null,
	special: WaSpecial | null,
	body: string,
): media is AlbumItem['media'] {
	return !!media &&
		(media.kind === 'image' || media.kind === 'video' || media.kind === 'gif') &&
		!special && body.length <= 1024
}

function bufferAlbumItem(jid: string, m: proto.IWebMessageInfo, item: AlbumItem): void {
	const key = albumKey(jid, m)
	const existing = pendingAlbums.get(key)
	if (existing) {
		existing.items.push(item)
		return
	}
	const timer = setTimeout(() => {
		void flushAlbum(key).catch((e) => console.error('[BRIDGE] album flush failed:', e))
	}, ALBUM_WINDOW_MS)
	pendingAlbums.set(key, { items: [item], timer })
}

// Flush every pending album group of a chat (called before a non-eligible
// message sends, preserving chat order).
async function flushPendingAlbums(jid: string): Promise<void> {
	const keys = [...pendingAlbums.keys()].filter((k) => k.startsWith(`${jid}\n`))
	for (const key of keys) await flushAlbum(key)
}

async function flushAlbum(key: string): Promise<void> {
	const entry = pendingAlbums.get(key)
	if (!entry) return
	pendingAlbums.delete(key)
	clearTimeout(entry.timer)
	const { items } = entry
	if (items.length === 0 || !db || !limiter || !tg) return
	const jid = key.split('\n')[0]
	const mapping = db.getByJid(jid)
	if (!mapping || mapping.archived || mapping.muted) return

	if (items.length === 1) {
		const it = items[0]
		await limiter.enqueue(() =>
			sendToTopic(it.topicId, it.body, it.entities, it.media, null, jid, it.m, {
				tgId: it.replyToTgId,
				header: null,
			})
		).catch((e) => console.error('[BRIDGE] failed to relay album singleton:', e))
		return
	}

	// Telegram caps media groups at 10 — chunk larger bursts.
	for (let c = 0; c < items.length; c += 10) {
		const chunk = items.slice(c, c + 10)
		const first = chunk[0]
		await limiter.enqueue(async () => {
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
				const sentArr = await tg!.api.sendMediaGroup(supergroupId, inputMedia as any, {
					message_thread_id: first.topicId,
					...reply,
				}) as { message_id: number }[]
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
						)
					}
				})
				// Captions beyond the first don't fit in a media group —
				// deliver them as one follow-up instead of dropping them.
				const extras = chunk.slice(1).map((it) => it.body).filter((b) => b)
				if (extras.length > 0) {
					const followBody = extras.join('\n')
					const sent = await tg!.api.sendMessage(supergroupId, followBody, {
						message_thread_id: first.topicId,
					})
					const last = chunk[chunk.length - 1]
					db!.saveReplyMap(
						sent.message_id,
						jid,
						last.m.key?.id || '',
						JSON.stringify(last.m.key || {}),
						'text',
						storedText(followBody),
						null,
					)
				}
			} catch (e) {
				console.error('[BRIDGE] failed to relay album group:', e)
				await notifyTopic(first.topicId, `⚠️ Couldn't relay a photo group: ${shortErr(e)}`)
			}
		})
	}
}

async function resolveChatName(
	jid: string,
	pushName: string | undefined | null,
	isGroup: boolean,
): Promise<string> {
	if (isGroup) {
		const cached = groupNameCache.get(jid)
		if (cached) return cached
		try {
			const meta = await bot.sock.groupMetadata(jid)
			if (meta?.subject) {
				groupNameCache.set(jid, meta.subject)
				return meta.subject
			}
		} catch {
			// fall through to pushName/phone
		}
		const fallback = pushName || jid.split('@')[0]
		groupNameCache.set(jid, fallback)
		return fallback
	}
	return pushName || phoneOf(jid) || jid.split('@')[0]
}

function phoneOf(jid: string | undefined | null): string {
	if (!jid) return ''
	const user = jid.split('@')[0].split(':')[0]
	return user ? `+${user}` : ''
}

// Best-effort ⚠️ notice to the affected topic so a relay failure is visible
// where the user looks, not just in server logs. Never throws and never
// loops: it sends via tg.api directly, and the TG→WA side ignores the bot's
// own messages.
async function notifyTopic(topicId: number, line: string): Promise<void> {
	if (!tg || !limiter) return
	try {
		await limiter.enqueue(() =>
			tg!.api.sendMessage(supergroupId, line, { message_thread_id: topicId })
		)
	} catch {
		// The notice itself failed — the server log already has the details.
	}
}

// First line of an error, capped — for topic notices, not logs.
function shortErr(e: unknown): string {
	const raw = typeof e === 'string'
		? e
		: ((e as { description?: unknown; message?: unknown })?.description ??
			(e as { message?: unknown })?.message ??
			String(e))
	return String(raw).split('\n')[0].slice(0, 160) || 'unknown error'
}

// True when the WA message carries a media node (so a null download means
// failure, not "no media"). Mirrors downloadWaMedia's node detection.
function hasDownloadableMedia(m: proto.IWebMessageInfo): boolean {
	try {
		const raw = unwrap(m.message)
		if (!raw || typeof raw !== 'object') return false
		return !!(
			raw.imageMessage ||
			raw.videoMessage ||
			raw.ptvMessage ||
			raw.audioMessage ||
			raw.stickerMessage ||
			raw.documentMessage
		)
	} catch {
		return false
	}
}

// WhatsApp reaction → Telegram reaction. Each side mirrors through a single
// bot identity (bots get one reaction per message on Telegram, one react per
// key on WhatsApp), so concurrent reactors are last-writer-wins by design.
async function handleWaReactions(
	reactions: { key: proto.IMessageKey; reaction: proto.IReaction }[],
): Promise<void> {
	if (!db || !limiter || !tg) return

	for (const { key, reaction } of reactions) {
		try {
			const targetId = key?.id
			const jid = key?.remoteJid
			if (!targetId || !jid || jid === 'status@broadcast') continue
			const mapping = db.getByJid(jid)
			if (!mapping || mapping.archived || mapping.muted) continue
			// Unmapped targets (pre-bridge history, pruned) can't be quoted
			// by Telegram — nothing to attach the reaction to.
			const target = db.getByWaMsgId(targetId, jid)
			if (!target) {
				console.debug(
					`[BRIDGE] skipping WA reaction: target ${targetId} not in reply_map`,
				)
				continue
			}

			const emoji = waReactionToTgEmoji(reaction?.text)
			// Echo of our own TG→WA react (marked before the WA send) — the
			// TG message already shows this reaction; re-setting would loop.
			// NOTE: no blanket fromMe skip here. The bridge socket is the
			// owner's account, so genuine reactions made on the owner's phone
			// arrive with fromMe=true too — skipping those would drop every
			// own-phone reaction silently (only the marked echo is skipped).
			if (db.takeTgReact(jid, targetId, emoji || '')) {
				console.debug(
					`[BRIDGE] skipping echo of TG-initiated react ${emoji} on ${targetId}`,
				)
				continue
			}
			const payload = emoji ? [{ type: 'emoji' as const, emoji }] : []
			await limiter.enqueue(async () => {
				try {
					await tg!.api.setMessageReaction(supergroupId, target.tg_msg_id, payload as any)
					console.debug(
						`[BRIDGE] WA→TG reaction ${
							emoji || '(removed)'
						} on TG msg ${target.tg_msg_id}`,
					)
				} catch (e) {
					// REACTION_INVALID = the emoji isn't usable here (not a
					// Telegram reaction at all, or disabled in this chat's
					// Settings → Reactions). Retry once with the default
					// reaction so the sentiment still lands in the topic
					// instead of being silently dropped. A failing default
					// (reactions fully disabled?) gives up quietly — no
					// recursion. Never rethrows — reactions must not spam
					// the limiter log.
					const desc = reactionErrorDescription(e)
					if (desc.includes('REACTION_INVALID') && emoji) {
						try {
							await tg!.api.setMessageReaction(supergroupId, target.tg_msg_id, [
								{ type: 'emoji', emoji: DEFAULT_TG_REACTION },
							] as any)
							console.debug(
								`[BRIDGE] WA→TG reaction ${emoji} unsupported, used default ${DEFAULT_TG_REACTION} on TG msg ${target.tg_msg_id}`,
							)
						} catch (e2) {
							console.debug(
								`[BRIDGE] default reaction ${DEFAULT_TG_REACTION} also rejected on TG msg ${target.tg_msg_id}: ${
									reactionErrorDescription(e2)
								}`,
							)
						}
						if (warnedReactions.has(emoji)) {
							console.debug(
								`[BRIDGE] unsupported reaction ${emoji} (known, defaulted)`,
							)
						} else {
							warnedReactions.add(emoji)
							console.warn(
								`[BRIDGE] reaction ${emoji} rejected by Telegram (REACTION_INVALID): ` +
									`not a Telegram reaction emoji or disabled in this supergroup's Settings → Reactions. Used default ${DEFAULT_TG_REACTION} instead.`,
							)
						}
						return
					}
					throw e
				}
			})
		} catch (e) {
			console.error('[BRIDGE] failed to relay one WA reaction:', e)
		}
	}
}

// WhatsApp delete/revoke → delete the Telegram mirror. Deletes arrive as
// `messages.delete` with `{ keys }` (per-message revoke) or `{ jid, all }`
// (clear-chat, which has no meaningful topic equivalent and is skipped).
// Needs the bot to be supergroup admin with delete rights; messages older
// than ~48h or already gone just debug-log. The reply_map row is dropped on
// success so later edits/reactions to the deleted message don't 400.
async function handleWaDeletes(
	payload: { keys?: proto.IMessageKey[]; jid?: string; all?: boolean },
): Promise<void> {
	if (!db || !limiter || !tg) return
	if (!payload?.keys || payload.keys.length === 0) {
		console.debug('[BRIDGE] skipping WA delete: no keys (clear-chat or empty)')
		return
	}
	for (const key of payload.keys) {
		try {
			const id = key?.id
			const jid = key?.remoteJid
			if (!id || !jid || jid === 'status@broadcast') continue
			await deleteTgMirror(jid, id)
		} catch (e) {
			console.error('[BRIDGE] failed to relay one WA delete:', e)
		}
	}
}

// Cap mirror content stored for revoke-as-spoiler — enough for a tombstone,
// small enough to keep reply_map lean.
const STORED_TEXT_MAX = 1500

function storedText(body: string): string | null {
	if (!body) return null
	return body.length > STORED_TEXT_MAX ? body.slice(0, STORED_TEXT_MAX) : body
}

function storedEntities(entities: TgEntity[]): string | null {
	if (!entities || entities.length === 0) return null
	try {
		return JSON.stringify(entities)
	} catch {
		return null
	}
}

// Marker heading a spoiler tombstone. The original content follows it,
// hidden behind a spoiler entity — users see WHY it's blurred.
const SPOILER_MARKER = '🗑️ Deleted on WhatsApp\n'

// Re-edit a mirrored message into a spoiler tombstone instead of deleting
// it. Returns true on success. Uses the STORED original (so repeat revokes
// are idempotent); text mirrors edit in place, media mirrors edit the
// caption. Anything else (stickers, specials, legacy rows without content)
// returns false so the caller falls back to deleting.
async function spoilerTgMirror(target: ReplyMapRow): Promise<boolean> {
	if (!tg || !limiter || !db) return false
	const kind = target.tg_kind
	if (kind !== 'text' && kind !== 'media' && kind !== 'unknown') return false
	const orig = (target.tg_text || '').slice(0, STORED_TEXT_MAX)
	if (!orig) return false
	let kept: TgEntity[] = []
	try {
		const parsed: unknown = JSON.parse(target.tg_entities || '[]')
		if (Array.isArray(parsed)) {
			kept = (parsed as any[]).filter((e) =>
				e && typeof e.offset === 'number' && typeof e.length === 'number' &&
				e.offset >= 0 && e.length > 0 && e.offset + e.length <= orig.length &&
				typeof e.type === 'string'
			).map((e) => ({ type: e.type as TgEntity['type'], offset: e.offset, length: e.length }))
		}
	} catch {
		kept = []
	}
	for (const e of kept) e.offset += SPOILER_MARKER.length
	kept.push({ type: 'spoiler', offset: SPOILER_MARKER.length, length: orig.length })
	const rich = kept.length > 0 ? { entities: kept } : undefined
	let ok = false
	try {
		await limiter.enqueue(async () => {
			try {
				if (kind === 'media') {
					const caption = (SPOILER_MARKER + orig).slice(0, 1024)
					const cEnts = kept.filter((e) => e.offset + e.length <= caption.length)
					await tg!.api.editMessageCaption(supergroupId, target.tg_msg_id, {
						caption,
						caption_entities: cEnts.length > 0 ? cEnts : undefined,
					})
				} else {
					await tg!.api.editMessageText(
						supergroupId,
						target.tg_msg_id,
						SPOILER_MARKER + orig,
						rich,
					)
				}
				console.debug(`[BRIDGE] WA→TG revoke spoilered TG msg ${target.tg_msg_id}`)
				ok = true
			} catch (e) {
				console.debug(
					`[BRIDGE] spoiler edit of TG msg ${target.tg_msg_id} failed, trying delete: ${
						describeErr(e)
					}`,
				)
				ok = false
			}
		})
	} catch {
		ok = false
	}
	return ok
}

// Delete the Telegram mirror of a revoked/deleted WA message. Shared by the
// `messages.delete` path (delete-for-me syncs) and the REVOKE branch of
// `messages.update` (delete-for-everyone). Prefers re-editing the mirror
// into a spoiler tombstone (content stays visible on tap); only mirrors
// without stored content (TG-originated rows, stickers, specials) or failed
// spoiler edits are actually deleted. Drops the reply_map row when the
// message ends up deleted so later edits/reactions to it don't 400.
async function deleteTgMirror(jid: string, id: string): Promise<void> {
	if (!db || !limiter || !tg) return
	const mapping = db.getByJid(jid)
	if (!mapping || mapping.archived || mapping.muted) return
	const target = db.getByWaMsgId(id, jid)
	if (!target) {
		console.debug(`[BRIDGE] skipping WA delete: target ${id} not in reply_map`)
		return
	}
	if (await spoilerTgMirror(target)) return
	await limiter.enqueue(async () => {
		try {
			await tg!.api.deleteMessage(supergroupId, target.tg_msg_id)
			db!.deleteReplyMap(target.tg_msg_id)
			console.debug(`[BRIDGE] WA→TG delete of TG msg ${target.tg_msg_id}`)
		} catch (e) {
			logDeleteFailure(target.tg_msg_id, e)
		}
	})
}

function logDeleteFailure(tgMsgId: number, err: unknown): void {
	const desc = reactionErrorDescription(err).toLowerCase()
	const line = `[BRIDGE] delete of TG message ${tgMsgId} failed: ${reactionErrorDescription(err)}`
	// Gone/expired mirrors and missing admin rights are environmental, not bugs.
	if (
		desc.includes('not found') || desc.includes("can't be deleted") || desc.includes('too old')
	) {
		console.debug(line)
	} else if (desc.includes('right') || desc.includes('admin') || desc.includes('forbidden')) {
		console.warn(`${line} (bot needs delete rights in the supergroup)`)
	} else {
		console.error(line)
	}
}

// Emojis already warned about (REACTION_INVALID) so repeats stay at debug.
const warnedReactions = new Set<string>()

// Default Telegram reaction set when an incoming WhatsApp reaction emoji is
// rejected (REACTION_INVALID — unknown to Telegram or disabled in the
// supergroup's Settings → Reactions). Plain ❤ without VS16, always in
// Telegram's allowed set; mirrors the TG→WA custom-emoji fallback.
const DEFAULT_TG_REACTION = '❤'

function reactionErrorDescription(err: unknown): string {
	if (typeof err === 'string') return err
	const anyErr = err as { description?: unknown; message?: unknown }
	if (typeof anyErr?.description === 'string') return anyErr.description
	if (typeof anyErr?.message === 'string') return anyErr.message
	return ''
}

// Normalize a WhatsApp reaction emoji for Telegram's reaction set:
// strip VS16 (❤️→❤) and skin-tone modifiers (👍🏽→👍), then map common
// WhatsApp reactions that Telegram simply doesn't offer (😂→🤣, …).
// Returns the emoji as-is when unknown — Telegram may still accept it —
// and null for removals (empty text) so the caller clears the reaction.
export function waReactionToTgEmoji(text: string | null | undefined): string | null {
	if (!text) return null
	const clean = text.replace(/\uFE0F/g, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '').trim()
	if (!clean) return null
	return WA_TO_TG_REACTION_FALLBACK[clean] || clean
}

// Everyday WhatsApp reactions with no Telegram reaction counterpart (all
// targets verified against Telegram's allowed reaction list). Anything not
// listed here is forwarded verbatim — REACTION_INVALID, if it comes, is
// contained by the caller above.
const WA_TO_TG_REACTION_FALLBACK: Record<string, string> = {
	'😂': '🤣',
	'😊': '🥰',
	'😅': '😁',
	'😌': '😇',
	'😏': '😎',
	'🥲': '😢',
	'😮': '😱',
	'😳': '😱',
	'🥺': '😢',
	'😤': '😡',
	'🙌': '🎉',
	'🫶': '❤',
	'💖': '❤',
	'💕': '❤',
}

async function createForumTopic(displayName: string, _isGroup: boolean): Promise<number> {
	if (!tg) throw new Error('Telegram bot not initialized')
	const name = (displayName || 'Unknown').slice(0, 128) || 'Unknown'
	const topic = await tg.api.createForumTopic(supergroupId, name)
	return topic.message_thread_id
}

async function sendToTopic(
	topicId: number,
	body: string,
	entities: TgEntity[],
	media:
		| { kind: string; buffer: Uint8Array; mime?: string; fileName?: string; ptt?: boolean }
		| null,
	special: WaSpecial | null,
	waJid: string,
	waMsg: proto.IWebMessageInfo,
	quote: { tgId: number | null; header: string | null },
): Promise<void> {
	if (!tg || !db) return
	// Native Telegram quote when the original was bridged. allow_sending_
	// without_reply keeps the send alive if that message was deleted since.
	const reply = quote.tgId
		? { reply_parameters: { message_id: quote.tgId, allow_sending_without_reply: true } }
		: undefined
	const rich = entities.length > 0 ? { entities } : undefined
	const thread = { message_thread_id: topicId } as const
	// Persist the mirror content alongside the mapping so a later revoke can
	// re-edit the message into a spoiler tombstone instead of deleting it.
	const save = (tgId: number, kind: MirrorKind): void => {
		db!.saveReplyMap(
			tgId,
			waJid,
			waMsg.key?.id || '',
			JSON.stringify(waMsg.key || {}),
			kind,
			storedText(body),
			storedEntities(entities),
		)
	}

	// Location / contact / poll have no caption concept: the content goes
	// first (carrying the native reply), then any text as a follow-up.
	if (special) {
		const sentId = await sendSpecial(topicId, special, reply)
		if (sentId) save(sentId, 'special')
		if (body) {
			const sent = await tg.api.sendMessage(supergroupId, body, {
				...thread,
				...rich,
			})
			save(sent.message_id, 'text')
		}
		return
	}

	if (!media) {
		const sent = await tg.api.sendMessage(supergroupId, body, {
			message_thread_id: topicId,
			...rich,
			...reply,
		})
		save(sent.message_id, 'text')
		return
	}

	// Stickers take no caption: deliver an unmapped quote header as its own
	// quote-styled message so the context still lands in the topic.
	if (media.kind === 'sticker' && quote.header && !quote.tgId) {
		await tg.api.sendMessage(supergroupId, quote.header, {
			message_thread_id: topicId,
			entities: [{ type: 'blockquote', offset: 0, length: quote.header.length }],
		})
	}

	const caption = body.length > 1024 ? undefined : (body || undefined)
	const captionEntities = caption && entities.length > 0
		? { caption_entities: entities }
		: undefined
	const file = new InputFile(media.buffer, media.fileName || `file.${extOf(media)}`)

	// Round video notes take no caption and need their own endpoint — a
	// non-round-compatible file falls back to a plain video instead.
	if (media.kind === 'round') {
		let sentNote: { message_id: number }
		try {
			sentNote = await tg.api.sendVideoNote(supergroupId, file, { ...thread, ...reply })
		} catch {
			sentNote = await tg.api.sendVideo(supergroupId, file, {
				...thread,
				caption,
				...captionEntities,
				...reply,
			})
		}
		save(sentNote.message_id, 'media')
		if (body) {
			const sent = await tg.api.sendMessage(supergroupId, body, { ...thread, ...rich })
			save(sent.message_id, 'text')
		}
		return
	}

	let sent: { message_id: number }

	switch (media.kind) {
		case 'image':
			sent = await tg.api.sendPhoto(supergroupId, file, {
				...thread,
				caption,
				...captionEntities,
				...reply,
			})
			break
		case 'video':
		case 'gif':
			// WA GIFs are mp4 videos with gifPlayback — Telegram renders them
			// as GIFs (looping, muted) via sendAnimation instead of sendVideo.
			sent = media.kind === 'gif'
				? await tg.api.sendAnimation(supergroupId, file, {
					...thread,
					caption,
					...captionEntities,
					...reply,
				})
				: await tg.api.sendVideo(supergroupId, file, {
					...thread,
					caption,
					...captionEntities,
					...reply,
				})
			break
		case 'voice':
			sent = await tg.api.sendVoice(supergroupId, file, {
				...thread,
				caption,
				...captionEntities,
				...reply,
			})
			break
		case 'audio':
			sent = await tg.api.sendAudio(supergroupId, file, {
				...thread,
				caption,
				...captionEntities,
				...reply,
			})
			break
		case 'sticker':
			sent = await tg.api.sendSticker(supergroupId, file, {
				message_thread_id: topicId,
				...reply,
			})
			break
		default:
			sent = await tg.api.sendDocument(supergroupId, file, {
				...thread,
				caption,
				...captionEntities,
				...reply,
			})
			break
	}
	save(sent.message_id, media.kind === 'sticker' ? 'sticker' : 'media')

	// Captions are capped at 1024 chars — send the overflow as a follow-up.
	if (caption === undefined && body) {
		await tg.api.sendMessage(supergroupId, body, { message_thread_id: topicId, ...rich })
	}
}

// Sends a location/contact/poll content message. Returns the sent Telegram
// message id (null when the content degrades to a text fallback instead).
async function sendSpecial(
	topicId: number,
	special: WaSpecial,
	reply:
		| { reply_parameters: { message_id: number; allow_sending_without_reply: boolean } }
		| undefined,
): Promise<number | null> {
	if (!tg) return null
	const thread = { message_thread_id: topicId } as const
	switch (special.kind) {
		case 'location': {
			const sent = await tg.api.sendLocation(
				supergroupId,
				special.latitude,
				special.longitude,
				{ ...thread, ...reply },
			)
			return sent.message_id
		}
		case 'contact': {
			const sent = await tg.api.sendContact(supergroupId, special.phone, special.name, {
				...thread,
				...reply,
			})
			return sent.message_id
		}
		case 'poll': {
			const question = special.question.slice(0, 300) || 'Poll'
			const options = special.options
				.map((o) => o.slice(0, 100))
				.filter((o) => o.length > 0)
				.slice(0, 10)
			// Telegram needs 2–10 options; shorter lists were already
			// degraded to text by the caller, so this is just a guard.
			if (options.length < 2) return null
			const sent = await tg.api.sendPoll(
				supergroupId,
				question,
				options.map((text) => ({ text })),
				{
					...thread,
					is_anonymous: false,
					...reply,
				},
			)
			return sent.message_id
		}
	}
}

// Location / contact / poll extraction (WhatsApp → Telegram).
export interface WaSpecialLocation {
	kind: 'location'
	latitude: number
	longitude: number
}
export interface WaSpecialContact {
	kind: 'contact'
	name: string
	phone: string
}
export interface WaSpecialPoll {
	kind: 'poll'
	question: string
	options: string[]
}
export type WaSpecial = WaSpecialLocation | WaSpecialContact | WaSpecialPoll

export function getSpecialContent(message: proto.IMessage | undefined | null): WaSpecial | null {
	try {
		const raw = unwrap(message)
		if (!raw || typeof raw !== 'object') return null
		if (raw.locationMessage) {
			const { degreesLatitude, degreesLongitude } = raw.locationMessage
			if (typeof degreesLatitude === 'number' && typeof degreesLongitude === 'number') {
				return { kind: 'location', latitude: degreesLatitude, longitude: degreesLongitude }
			}
		}
		if (raw.liveLocationMessage) {
			const { latitude, longitude } = raw.liveLocationMessage
			if (typeof latitude === 'number' && typeof longitude === 'number') {
				return { kind: 'location', latitude, longitude }
			}
		}
		if (raw.contactMessage) {
			const { name, phone } = parseVcard(raw.contactMessage.vcard)
			return {
				kind: 'contact',
				name: raw.contactMessage.displayName || name || phone || 'Contact',
				phone,
			}
		}
		if (raw.pollCreationMessage) {
			const options = (raw.pollCreationMessage.options || [])
				.map((o: any) => String(o?.optionName || '').trim())
				.filter((o: string) => o.length > 0)
			return {
				kind: 'poll',
				question: String(raw.pollCreationMessage.name || 'Poll'),
				options,
			}
		}
		return null
	} catch {
		return null
	}
}

// WhatsApp message edit → Telegram edit. Edits arrive as `messages.update`
// with `update.message.editedMessage.message` (never as upsert). "Delete for
// everyone" revokes arrive on the SAME event with `update.message === null`
// and `messageStubType === REVOKE` — Baileys only emits `messages.delete`
// for local "delete for me" syncs, so revokes are handled here too. The
// mirror message is always bot-owned, so Telegram's 48h edit window is the
// only platform limit — but mirrors of stickers/polls/venues/contacts can't
// be edited at all, and rows predating tg_kind fall back to try-both.
async function handleWaEdits(
	updates: { key: proto.IMessageKey; update: { message?: any; messageStubType?: number } }[],
): Promise<void> {
	if (!db || !limiter || !tg) return

	for (const { key, update } of updates) {
		try {
			// Revoke ("delete for everyone") — same event, null message.
			if (update?.message == null && update?.messageStubType === WAMessageStubType.REVOKE) {
				const jid = key?.remoteJid
				const id = key?.id
				if (!jid || !id || jid === 'status@broadcast') continue
				// A TG-initiated edit mark is irrelevant here, but consuming
				// it keeps the guard set from growing stale.
				db.takeTgEdit(jid, id)
				await deleteTgMirror(jid, id)
				continue
			}
			const edited = update?.message?.editedMessage?.message
			// Anything else (receipts, status, poll votes, …) is not an edit —
			// skip silently, these fire constantly.
			if (!edited || typeof edited !== 'object') continue
			const jid = key?.remoteJid
			const id = key?.id
			if (!jid || !id || jid === 'status@broadcast') {
				console.debug('[BRIDGE] skipping WA edit: missing jid/id')
				continue
			}
			// Echo of our own TG→WA edit (marked before the WA send) — the
			// TG message already shows this text; editing would 400.
			if (db.takeTgEdit(jid, id)) {
				console.debug(`[BRIDGE] skipping echo of TG-initiated edit ${id}`)
				continue
			}
			const mapping = db.getByJid(jid)
			if (!mapping || mapping.archived || mapping.muted) {
				console.debug(`[BRIDGE] skipping WA edit ${id}: chat unmapped/archived/muted`)
				continue
			}
			const target = db.getByWaMsgId(id, jid)
			if (!target) {
				console.debug(`[BRIDGE] skipping WA edit: target ${id} not in reply_map`)
				continue
			}

			const route = routeEdit((target as { tg_kind?: string }).tg_kind)
			if (route === 'skip') {
				console.debug(
					`[BRIDGE] skipping edit of non-editable TG mirror (kind=${target.tg_kind})`,
				)
				continue
			}

			const isGroup = jid.endsWith('@g.us')
			const label = key.fromMe
				? 'You: '
				: (isGroup ? `${phoneOf(key.participant) || 'unknown'}: ` : '')
			const parsed = waMarkdownToTgEntities(
				annotateMentions(
					getMsgText(edited as proto.IMessage),
					mentionedJidsOf(edited),
				),
			)
			const body = `${label}${parsed.text}`
			const entities = parsed.entities.map((e) => ({ ...e, offset: e.offset + label.length }))
			const rich = entities.length > 0 ? { entities } : undefined

			await limiter.enqueue(async () => {
				try {
					if (route === 'text' || route === 'both') {
						await tg!.api.editMessageText(supergroupId, target.tg_msg_id, body, rich)
						return
					}
					await tg!.api.editMessageCaption(supergroupId, target.tg_msg_id, {
						caption: body.slice(0, 1024) || undefined,
					})
				} catch (first) {
					// Legacy 'unknown' rows: the mirror type is a guess, so a
					// failed text edit retries as caption before giving up.
					if (route === 'both') {
						try {
							await tg!.api.editMessageCaption(supergroupId, target.tg_msg_id, {
								caption: body.slice(0, 1024) || undefined,
							})
							return
						} catch (second) {
							logEditFailure(target.tg_msg_id, second, String(describeErr(first)))
							return
						}
					}
					logEditFailure(target.tg_msg_id, first)
				}
			})
		} catch (e) {
			console.error('[BRIDGE] failed to relay one WA edit:', e)
		}
	}
}

// Which Telegram edit endpoint a mirror kind needs. Stickers, polls,
// venues, contacts and locations have no bot-editable representation —
// attempting them only produces 400s, so they are skipped up front.
export function routeEdit(tgKind: string | undefined): 'text' | 'caption' | 'both' | 'skip' {
	switch (tgKind) {
		case 'text':
			return 'text'
		case 'media':
			return 'caption'
		case 'sticker':
		case 'special':
			return 'skip'
		default:
			return 'both'
	}
}

// Log an edit failure at the right level instead of always erroring:
// 'not modified' is a harmless duplicate, "can't be edited"/"not found" is
// an expired window, deleted message or wrong type — only the rest is a bug.
export function classifyEditError(err: unknown): 'debug' | 'warn' | 'error' {
	const desc = describeErr(err).toLowerCase()
	if (desc.includes('not modified')) return 'debug'
	if (desc.includes("can't be edited") || desc.includes('not found')) return 'warn'
	return 'error'
}

function describeErr(err: unknown): string {
	if (typeof err === 'string') return err
	const anyErr = err as { description?: unknown; message?: unknown }
	if (typeof anyErr?.description === 'string') return anyErr.description
	if (typeof anyErr?.message === 'string') return anyErr.message
	try {
		return JSON.stringify(err)
	} catch {
		return String(err)
	}
}

function logEditFailure(tgMsgId: number, err: unknown, firstErr?: string): void {
	const level = classifyEditError(err)
	const detail = `${describeErr(err)}${firstErr ? ` (first attempt: ${firstErr})` : ''}`
	const line = `[BRIDGE] edit of TG message ${tgMsgId} failed (${level}): ${detail}`
	if (level === 'debug') console.debug(line)
	else if (level === 'warn') console.warn(line)
	else console.error(line)
}

// Group membership changes → service lines in the topic.
async function handleGroupParticipants(upd: {
	id: string
	participants: (string | { id?: string })[]
	action: string
}): Promise<void> {
	if (!db || !limiter || !tg) return
	try {
		const mapping = db?.getByJid(upd.id)
		if (!mapping || mapping.archived || mapping.muted) return
		const names = (upd.participants || [])
			.map((p) => phoneOf(typeof p === 'string' ? p : p?.id) || 'someone')
			.join(', ')
		let line: string | null = null
		switch (upd.action) {
			case 'add':
				line = `👋 ${names} joined the group`
				break
			case 'remove':
				line = `🚪 ${names} left the group`
				break
			case 'promote':
				line = `⭐ ${names} is now an admin`
				break
			case 'demote':
				line = `◽ ${names} is no longer an admin`
				break
			default:
				return
		}
		await limiter.enqueue(() =>
			tg!.api.sendMessage(supergroupId, line!, {
				message_thread_id: mapping.telegram_topic_id,
			})
		)
	} catch (e) {
		console.error('[BRIDGE] failed to relay group participants:', e)
	}
}

// Group subject changes → rename mapping + topic (best effort).
async function handleGroupUpdates(
	updates: Partial<{ id: string; subject: string }>[],
): Promise<void> {
	if (!db || !limiter || !tg) return
	for (const u of updates || []) {
		try {
			if (!u?.id || !u.subject) continue
			const mapping = db.getByJid(u.id)
			if (!mapping || mapping.archived || mapping.muted) continue
			if (mapping.display_name === u.subject) continue
			groupNameCache.set(u.id, u.subject)
			db.getOrCreate(u.id, mapping.telegram_topic_id, u.subject, mapping.chat_type)
			await limiter.enqueue(() =>
				tg!.api.editForumTopic(supergroupId, mapping.telegram_topic_id, {
					name: u.subject!.slice(0, 128),
				}).catch(() => false)
			)
			console.log(`[BRIDGE] renamed topic #${mapping.telegram_topic_id} to ${u.subject}`)
		} catch (e) {
			console.error('[BRIDGE] failed to relay group update:', e)
		}
	}
}

function extOf(media: { kind: string; mime?: string }): string {
	if (media.mime?.includes('/')) {
		const ext = media.mime.split('/')[1].split(';')[0].split('+')[0]
		if (ext && ext.length <= 5) return ext
	}
	switch (media.kind) {
		case 'image':
			return 'jpg'
		case 'video':
		case 'round':
		case 'gif':
			return 'mp4'
		case 'voice':
		case 'audio':
			return 'ogg'
		case 'sticker':
			return 'webp'
		default:
			return 'bin'
	}
}

function getMsgText(message: proto.IMessage): string {
	for (const key of ['conversation', 'text', 'caption']) {
		const res = findKey(message, key)
		if (res) return String(res).trim()
	}
	return ''
}

// Phone (`+<digits>`) for a mentionable WhatsApp JID, or null for anything
// that isn't a plain phone JID (LIDs, groups, broadcasts, short/invalid).
export function jidPhone(jid: string | undefined | null): string | null {
	if (!jid || typeof jid !== 'string') return null
	const [user, server] = jid.split('@')
	if (server !== 's.whatsapp.net' && server !== 'c.us') return null
	const digits = (user || '').split(':')[0].replace(/\D/g, '')
	if (!/^\d{7,15}$/.test(digits)) return null
	return `+${digits}`
}

// Mentioned JIDs (contextInfo.mentionedJid) off an unwrapped content node.
// Same direct top-level scan as getQuoteInfo — never a deep search.
function mentionedJidsOf(raw: any): string[] {
	try {
		if (!raw || typeof raw !== 'object') return []
		for (const value of Object.values(raw)) {
			if (value && typeof value === 'object') {
				const list = (value as any).contextInfo?.mentionedJid
				if (Array.isArray(list)) return list.filter((j) => typeof j === 'string')
			}
		}
	} catch {
		// fall through
	}
	return []
}

// Mentioned JIDs of an incoming WhatsApp message.
export function getMentionedJids(m: proto.IWebMessageInfo): string[] {
	try {
		return mentionedJidsOf(unwrap(m.message))
	} catch {
		return []
	}
}

// Annotate `@name` mentions with the member's phone number: WhatsApp shows
// the contact name but Telegram can't resolve the identity, so
// "hi @John" + mentionedJid 1555@s.whatsapp.net becomes
// "hi @John (+1555…)". Pairs @tokens in order with the JID list (which is
// how WhatsApp orders them); tokens already containing the number and
// unresolvable JIDs pass through untouched. Runs BEFORE entity parsing so
// formatting offsets stay consistent.
export function annotateMentions(text: string, mentionedJids: string[]): string {
	if (!text || mentionedJids.length === 0) return text
	const phones = mentionedJids.map(jidPhone)
	let i = 0
	// Trailing punctuation (,@John, …) stays outside the token so the phone
	// lands next to the name: "@John, hi" → "@John (+…), hi".
	return text.replace(/@[^@\s.,;:!?)]+/g, (tok) => {
		if (i >= phones.length) return tok
		const phone = phones[i++]
		if (!phone) return tok
		if (tok.replace(/\D/g, '').endsWith(phone.slice(-7))) return tok
		return `${tok} (${phone})`
	})
}

interface WaQuote {
	stanzaId: string
	preview: string
	author: string
}

export type { WaQuote }

// Extract the WhatsApp quote (contextInfo) from an incoming message, if any.
// Reads contextInfo off the unwrapped top-level content node directly —
// never a deep search — so a nested quote-inside-a-quote can't be mistaken
// for the outer one. (findKey also skips quotedMessage subtrees, which is
// why getMsgText above returns the reply's own text, not the quoted text.)
export function getQuoteInfo(m: proto.IWebMessageInfo, fallbackAuthor: string): WaQuote | null {
	try {
		const raw = unwrap(m.message)
		if (!raw || typeof raw !== 'object') return null
		let ctx: any = null
		for (const value of Object.values(raw)) {
			if (value && typeof value === 'object' && (value as any).contextInfo?.stanzaId) {
				ctx = (value as any).contextInfo
				break
			}
		}
		if (!ctx) return null
		return {
			stanzaId: String(ctx.stanzaId),
			preview: describeQuoted(ctx.quotedMessage),
			author: ctx.participant ? phoneOf(ctx.participant) : fallbackAuthor,
		}
	} catch {
		return null
	}
}

// Short human-readable summary of the quoted original for the fallback
// header (used only when the original was never bridged to Telegram).
function describeQuoted(quotedMessage: any): string {
	if (quotedMessage && typeof quotedMessage === 'object') {
		const text = getMsgText(quotedMessage as proto.IMessage)
		if (text) return text.length > 200 ? text.slice(0, 200) + '…' : text
		const key = Object.keys(quotedMessage)[0] || ''
		if (key.includes('image')) return '📷 a photo'
		if (key.includes('video')) return '🎥 a video'
		if (key.includes('audio')) return '🎵 an audio message'
		if (key.includes('sticker')) return 'a sticker'
		if (key.includes('document')) return '📄 a document'
		if (key.includes('location')) return '📍 a location'
		if (key.includes('contact')) return '👤 a contact'
		if (key.includes('poll')) return '📊 a poll'
	}
	return 'a message'
}

interface WaMedia {
	kind: 'image' | 'video' | 'round' | 'gif' | 'voice' | 'audio' | 'sticker' | 'document'
	buffer: Uint8Array
	mime?: string
	fileName?: string
	ptt?: boolean
}

async function downloadWaMedia(m: proto.IWebMessageInfo): Promise<WaMedia | null> {
	try {
		const raw = unwrap(m.message)
		if (!raw) return null

		let kind: WaMedia['kind'] | null = null
		let node: any = null
		if (raw.imageMessage) {
			kind = 'image'
			node = raw.imageMessage
		} else if (raw.ptvMessage) {
			// Round video-note messages arrive as ptvMessage, not videoMessage.
			kind = 'round'
			node = raw.ptvMessage
		} else if (raw.videoMessage) {
			// GIFs are videoMessages with the gifPlayback flag.
			kind = raw.videoMessage.gifPlayback ? 'gif' : 'video'
			node = raw.videoMessage
		} else if (raw.audioMessage) {
			kind = raw.audioMessage.ptt ? 'voice' : 'audio'
			node = raw.audioMessage
		} else if (raw.stickerMessage) {
			kind = 'sticker'
			node = raw.stickerMessage
		} else if (raw.documentMessage) {
			kind = 'document'
			node = raw.documentMessage
		} else {
			return null
		}
		if (!node?.url && !node?.directPath) return null

		const buffer = await downloadMediaMessage(
			m as any,
			'buffer',
			{},
			{ reuploadRequest: bot.sock.updateMediaMessage, logger },
		).catch(() => null) as Buffer | Uint8Array | null
		if (!buffer) return null

		return {
			kind,
			buffer: new Uint8Array(buffer),
			mime: node.mimetype,
			fileName: node.fileName,
			ptt: node.ptt,
		}
	} catch {
		return null
	}
}

// Peel view-once / ephemeral wrappers so media underneath is reachable.
function unwrap(message: proto.IMessage | undefined | null): any {
	let node: any = message
	for (let i = 0; i < 4 && node; i++) {
		if (node.viewOnceMessageV2) node = node.viewOnceMessageV2.message
		else if (node.viewOnceMessage) node = node.viewOnceMessage.message
		else if (node.ephemeralMessage) node = node.ephemeralMessage.message
		else if (node.documentWithCaptionMessage) node = node.documentWithCaptionMessage.message
		else break
	}
	return node
}
