// Telegram → WhatsApp relay.
//
// Sends through the SHARED WhatsApp socket (bot.sock singleton), so there is
// only ever one WhatsApp connection. Text, captions, media and Telegram
// replies (→ WhatsApp quoted replies) are supported.
import { Bot } from 'grammy'
import bot from '@plugin/bot.ts'
import type { BridgeDB } from './db.ts'
import type { RateLimiter } from './rate-limiter.ts'
import { tgEntitiesToWa } from './format.ts'

export function registerTgHandlers(tg: Bot, db: BridgeDB, limiter: RateLimiter): void {
	const supergroupId = String(Deno.env.get('TELEGRAM_SUPERGROUP_ID'))
	const inSupergroup = (ctx: { chat?: { id?: string | number } }): boolean =>
		String(ctx.chat?.id) === supergroupId

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
			await ctx.reply(`Muted ${mapping.display_name} — nothing relays until /unmute.`)
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
			await ctx.reply(`Unmuted ${mapping.display_name} — relay resumed.`)
		}
	})

	// Start a bridged chat from the Telegram side: `/new <phone> [name]`.
	// Verifies the number on WhatsApp, creates the forum topic + mapping —
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
			const existing = db.getByJid(jid)
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
			const name = (args.slice(1).join(' ') || `+${digits}`).replace(/[\n\r]+/g, ' ').trim()
				.slice(0, 128) || `+${digits}`
			const topic = await limiter.enqueue(() => tg.api.createForumTopic(supergroupId, name))
			db.getOrCreate(jid, topic.message_thread_id, name, '1:1')
			await ctx.reply(
				`Bridged +${digits} → topic #${topic.message_thread_id}. Write there to send.`,
			)
		} catch (e) {
			console.error('[BRIDGE] TG→WA /new failed:', e)
		}
	})

	// Telegram reaction → WhatsApp reaction. Like quotes, this resolves the
	// reacted-to Telegram message through reply_map to the WA key it mirrors.
	// Requires the bot to be supergroup admin + message_reaction in
	// allowed_updates (see mod.ts) — otherwise these updates never arrive.
	// Loop guard: our own WA→TG setMessageReaction does NOT echo back (per
	// Telegram docs, bots don't receive updates for reactions set by bots),
	// and the WA side consumes the one server echo via markTgReact/takeTgReact.
	tg.on('message_reaction', async (ctx) => {
		try {
			const upd: any = ctx.update.message_reaction
			if (!upd || String(upd.chat?.id) !== supergroupId) return
			if (upd.user?.is_bot) return
			if (!upd.message_id) return

			const entry = db.getReplyMap(upd.message_id)
			if (!entry) {
				return
			}
			if (db.getByJid(entry.wa_jid)?.muted) return
			const key = restoreWaKey(entry)
			if (!key) {
				return
			}

			const emoji = tgReactionToWaEmoji(upd.old_reaction, upd.new_reaction)
			// Marked synchronously so the server echo of this react
			// (arriving as WA `messages.reaction` with fromMe=true) is
			// recognized and skipped instead of re-reacting on Telegram.
			db.markTgReact(entry.wa_jid, entry.wa_msg_id, emoji)
			await limiter.enqueue(async () => {
				await bot.sock.sendMessage(entry.wa_jid, { react: { text: emoji, key } })
			})
		} catch (e) {
			console.error('[BRIDGE] TG→WA reaction failed:', e)
		}
	})

	// Telegram album batching (TG→WA). Items of one media_group_id arrive as
	// separate updates; they wait out TG_ALBUM_WINDOW_MS and forward in
	// message_id order through the normal single-send path (Baileys has no
	// album-send API, so batching buys ordering, not a WA album).
	const TG_ALBUM_WINDOW_MS = 1200
	interface TgAlbumItem {
		msg: any
		topicId: number
		text: string
		media: TgMedia
	}
	const pendingTgAlbums = new Map<
		string,
		{ items: TgAlbumItem[]; timer: ReturnType<typeof setTimeout> }
	>()

	function bufferTgAlbumItem(groupId: string, item: TgAlbumItem): void {
		const existing = pendingTgAlbums.get(groupId)
		if (existing) {
			if (existing.items.length < 10) existing.items.push(item)
			return
		}
		const timer = setTimeout(() => {
			void flushTgAlbum(groupId).catch((e) =>
				console.error('[BRIDGE] TG album flush failed:', e)
			)
		}, TG_ALBUM_WINDOW_MS)
		pendingTgAlbums.set(groupId, { items: [item], timer })
	}

	async function flushTgAlbum(groupId: string): Promise<void> {
		const entry = pendingTgAlbums.get(groupId)
		if (!entry) return
		pendingTgAlbums.delete(groupId)
		clearTimeout(entry.timer)
		const items = entry.items
			.sort((a, b) => (a.msg.message_id || 0) - (b.msg.message_id || 0))
			.slice(0, 10)
		if (items.length === 0) return
		const first = items[0]
		const mapping = db.getByTopicId(first.topicId)
		if (!mapping || mapping.archived || mapping.muted) return
		const quoted = buildQuoted(first.msg, mapping.whatsapp_jid, db)
		let attached = false
		let notified = false
		for (const [i, it] of items.entries()) {
			try {
				const waContent = await buildWaContent(it.text, it.media, it.msg)
				if (!waContent) continue
				const useQuoted = !attached ? quoted : null
				await limiter.enqueue(async () => {
					const sent = await bot.sock.sendMessage(
						mapping.whatsapp_jid,
						waContent,
						useQuoted ? { quoted: useQuoted } : undefined,
					)
					if (sent?.key?.id) {
						db.saveReplyMap(
							it.msg.message_id,
							mapping.whatsapp_jid,
							sent.key.id,
							JSON.stringify(sent.key),
						)
					}
					db.updateLastActive(mapping.whatsapp_jid)
				})
				attached = true
			} catch (e) {
				console.error('[BRIDGE] TG→WA album item failed:', e)
				if (!notified) {
					notified = true
					await notifyTopic(
						tg,
						limiter,
						first.topicId,
						`⚠️ Couldn't send part of a Telegram album (item ${
							i + 1
						} of ${items.length}): ${shortErr(e)}`,
					)
				}
			}
		}
	}

	tg.on('message', async (ctx) => {
		try {
			const msg: any = ctx.msg
			// Only bridge the configured supergroup; ignore DMs/other groups.
			if (String(ctx.chat.id) !== supergroupId) return
			// Ignore the bot's own messages (loops) and non-topic (General) chatter.
			if (msg.from?.is_bot) return
			const topicId = msg.message_thread_id
			if (!topicId) return

			const mapping = db.getByTopicId(topicId)
			if (!mapping || mapping.archived) return
			if (mapping.muted) {
				return
			}

			// Telegram entities → WhatsApp markers (*bold*, _italic_, …) so
			// formatting survives the crossing in both text and captions.
			const rawText = msg.text || msg.caption || ''
			const text = tgEntitiesToWa(rawText, msg.entities || msg.caption_entities).trim()
			const dl = await downloadTgMedia(tg, msg)
			const media = dl?.media ?? null
			const unsupportedLabel = msg.dice
				? 'dice'
				: msg.venue
				? 'venue'
				: msg.game
				? 'game'
				: msg.video_chat_started || msg.video_chat_ended || msg.video_chat_participants_invited
				? 'video chat event'
				: null
			if (
				!text && !media && !msg.location && !msg.contact && !msg.poll && !msg.video_note &&
				!msg.animation && !unsupportedLabel
			) {
				return
			}
			if (unsupportedLabel && !text && !media) {
				await notifyTopic(
					tg,
					limiter,
					topicId,
					`⚠️ A Telegram ${unsupportedLabel} has no WhatsApp equivalent — it didn't cross.`,
				)
				return
			}
			// A media node whose download failed (or was skipped as too large
			// for the Bot API) would otherwise vanish silently — tell the
			// topic what exactly didn't cross instead of dropping it.
			if (dl && !dl.media) {
				await notifyTopic(
					tg,
					limiter,
					topicId,
					tgDownloadFailureLine(dl.label, dl.bytes, dl.tooLarge),
				)
				if (!text) return
			}

			// Telegram album items arrive as separate updates sharing a
			// media_group_id — collect them over a short window and forward
			// in order (Baileys has no album-send, so this buys ordering).
			const groupId = msg.media_group_id as string | undefined
			if (groupId && media && (media.kind === 'image' || media.kind === 'video')) {
				bufferTgAlbumItem(groupId, { msg, topicId, text, media })
				return
			}

			let quoted = buildQuoted(msg, mapping.whatsapp_jid, db)
			let textForWa = text
			if (!quoted && msg.reply_to_message) {
				const author = msg.reply_to_message.from?.first_name ||
					msg.reply_to_message.from?.username || 'user'
				const preview = (msg.reply_to_message.text || msg.reply_to_message.caption || '')
					.slice(0, 200)
				if (preview) textForWa = `↩️ ${author}: ${preview}\n${text}`.trim()
			}
			const waContent = await buildWaContent(textForWa, media, msg)
			if (!waContent) return
			const needsTextFollowUp = !!textForWa &&
				(!!msg.location || !!msg.video_note ||
					(msg.contact && !String(waContent.text || '').includes(textForWa)))

			await limiter.enqueue(async () => {
				const sent = await bot.sock.sendMessage(
					mapping.whatsapp_jid,
					waContent,
					quoted ? { quoted } : undefined,
				)
				if (sent?.key?.id) {
					// Store the real key (not '{}'): buildQuoted reuses it for
					// TG→WA quotes, and getByWaMsgId needs the true stanzaId so
					// WA quotes of TG-originated messages resolve back here.
					db.saveReplyMap(
						msg.message_id,
						mapping.whatsapp_jid,
						sent.key.id,
						JSON.stringify(sent.key),
					)
				}
				if (needsTextFollowUp) {
					await bot.sock.sendMessage(mapping.whatsapp_jid, { text: textForWa })
				}
				db.updateLastActive(mapping.whatsapp_jid)
			})
		} catch (e) {
			console.error('[BRIDGE] TG→WA relay failed:', e)
			const topicId = (ctx.msg as any)?.message_thread_id
			if (topicId) {
				await notifyTopic(
					tg,
					limiter,
					topicId,
					`⚠️ Couldn't send to WhatsApp: ${shortErr(e)}`,
				)
			}
		}
	})

	// Telegram edit → WhatsApp edit. Resolves the edited message through
	// reply_map to the WA key it mirrors and sends a protocol MESSAGE_EDIT
	// (text only — a media caption edit degrades to editing the caption text;
	// failures, e.g. expired edit window, just log).
	tg.on('edited_message', async (ctx) => {
		try {
			const msg: any = ctx.editedMessage
			if (!msg) return
			if (String(ctx.chat.id) !== supergroupId) return
			if (msg.from?.is_bot) return
			const topicId = msg.message_thread_id
			if (!topicId) return

			const mapping = db.getByTopicId(topicId)
			if (!mapping || mapping.archived) return
			if (mapping.muted) return

			const rawText = msg.text || msg.caption || ''
			const text = tgEntitiesToWa(rawText, msg.entities || msg.caption_entities).trim()
			if (!text) return

			const entry = db.getReplyMap(msg.message_id)
			if (!entry) return
			const key = restoreWaKey(entry)
			if (!key) return

			// Marked synchronously so the server echo of this protocol
			// message (arriving as WA `messages.update`) is recognized and
			// skipped instead of re-editing the TG message it came from.
			db.markTgEdit(mapping.whatsapp_jid, entry.wa_msg_id)
			await limiter.enqueue(async () => {
				await bot.sock.sendMessage(mapping.whatsapp_jid, { text, edit: key })
				db.updateLastActive(mapping.whatsapp_jid)
			})
		} catch (e) {
			console.error('[BRIDGE] TG→WA edit failed:', e)
		}
	})
}

export async function buildWaContent(
	text: string,
	media: { kind: string; buffer: Uint8Array; fileName?: string; mime?: string } | null,
	msg: any,
): Promise<any> {
	if (msg.location) {
		const { latitude, longitude } = msg.location
		return {
			location: { degreesLatitude: latitude, degreesLongitude: longitude },
		}
	}
	if (msg.contact) {
		const c = msg.contact
		return {
			text: `Contact: ${c.first_name || ''} ${c.last_name || ''} ${c.phone_number || ''}`
				.trim(),
		}
	}
	if (msg.poll) {
		const p = msg.poll
		const opts = (p.options || []).map((o: any) => `- ${o.text}`).join('\n')
		return { text: `${text ? text + '\n' : ''}Poll: ${p.question}\n${opts}`.trim() }
	}
	if (!media) return text ? { text } : null

	// Baileys' getStream() only accepts Buffer | { stream } | { url }. A raw
	// Deno/Telegram Uint8Array falls through to `item.url.toString()` and
	// crashes with "Cannot read properties of undefined (reading 'toString')",
	// so convert every buffer to a Node Buffer first.
	const buf = Buffer.from(media.buffer)

	switch (media.kind) {
		case 'image':
			return { image: buf, caption: text || undefined }
		case 'video':
			return { video: buf, caption: text || undefined, mimetype: media.mime || 'video/mp4' }
		case 'video_note':
			// Round video messages: Baileys turns { video, ptv: true } into a
			// ptvMessage the WA clients render as a round bubble.
			return { video: buf, ptv: true, mimetype: 'video/mp4' }
		case 'gif':
			// Telegram animations are GIFs; gifPlayback renders them as such
			// on WhatsApp (ignored by clients that don't know the flag, in
			// which case it just plays as video — same as before).
			return {
				video: buf,
				gifPlayback: true,
				caption: text || undefined,
				mimetype: media.mime || 'video/mp4',
			}
		case 'voice':
			return { audio: buf, ptt: true, mimetype: 'audio/ogg; codecs=opus' }
		case 'audio':
			return { audio: buf, mimetype: media.mime || 'audio/mpeg' }
		case 'sticker':
			// WhatsApp stickers must be WebP. Telegram animated (.tgs, Lottie)
			// stickers can't be rendered by ffmpeg, so they still relay as a
			// document. Video (.webm) stickers are transcoded to animated
			// WebP first, falling back to video when conversion fails.
			if (media.mime === 'video/webm' || (media.fileName || '').endsWith('.webm')) {
				const webp = await convertWebmToStickerWebp(media.buffer).catch(() => null)
				if (webp) return { sticker: Buffer.from(webp) }
				return { video: buf, caption: text || undefined }
			}
			if (media.mime?.includes('tgs') || (media.fileName || '').endsWith('.tgs')) {
				return {
					document: buf,
					fileName: media.fileName || 'sticker.tgs',
					mimetype: media.mime || 'application/octet-stream',
					caption: text || undefined,
				}
			}
			return { sticker: buf }
		default:
			return {
				document: buf,
				fileName: media.fileName || 'file',
				mimetype: media.mime || 'application/octet-stream',
				caption: text || undefined,
			}
	}
}

// Transcode a Telegram video (.webm) sticker to an animated WebP WhatsApp
// sticker (512px, looping, ≤500KB). Async ffmpeg — never blocks the event
// loop. Returns null on any failure (no ffmpeg, undecodable input, still
// oversize after two quality levels) so the caller can fall back to video.
export async function convertWebmToStickerWebp(input: Uint8Array): Promise<Uint8Array | null> {
	const dir = await Deno.makeTempDir({ prefix: 'bridge-sticker-' })
	try {
		const inPath = `${dir}/in.webm`
		await Deno.writeFile(inPath, input)
		for (const [quality, fps] of [[60, 15], [25, 10]] as const) {
			const outPath = `${dir}/out_${quality}.webp`
			const proc = new Deno.Command('ffmpeg', {
				args: [
					'-y',
					'-t',
					'11',
					'-i',
					inPath,
					'-filter_complex',
					`[0:v]fps=${fps},scale=512:512:force_original_aspect_ratio=decrease,format=yuva420p,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000[out]`,
					'-map',
					'[out]',
					'-c:v',
					'libwebp',
					'-loop',
					'0',
					'-an',
					'-quality',
					String(quality),
					'-compression_level',
					'4',
					'-preset',
					'icon',
					outPath,
				],
				stdin: 'null',
				stdout: 'null',
				stderr: 'null',
				signal: AbortSignal.timeout(60_000),
			})
			const { success } = await proc.output().catch(() => ({ success: false }))
			if (!success) continue
			const out = await Deno.readFile(outPath).catch((): Uint8Array | null => null)
			if (out && out.length > 0 && out.length <= 500 * 1024) return out
		}
		return null
	} catch {
		return null
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {})
	}
}

// Rebuild the Baileys key of the WA message a Telegram message mirrors.
// Current rows carry the full key JSON; legacy rows stored '{}' — those are
// always TG-originated sends (fromMe), so the key can be synthesized.
export function restoreWaKey(
	entry: { wa_jid: string; wa_msg_id: string; wa_key_json: string },
): any {
	try {
		const key = JSON.parse(entry.wa_key_json)
		if (key?.id) return key
	} catch {
		// fall through to synthesis
	}
	if (entry.wa_msg_id) {
		return { remoteJid: entry.wa_jid, id: entry.wa_msg_id, fromMe: true }
	}
	return null
}

// Pick the WhatsApp reaction text for a Telegram reaction change. Empty
// string = removal. Custom-emoji and paid reactions have no WhatsApp
// equivalent, so they fall back to ❤️ (logged by the caller path).
export function tgReactionToWaEmoji(oldList: any[], newList: any[]): string {
	const oldR = oldList || []
	const newR = newList || []
	if (newR.length === 0) return ''
	const same = (a: any, b: any) =>
		a?.type === b?.type && (a?.emoji || a?.custom_emoji_id) === (b?.emoji || b?.custom_emoji_id)
	const fresh = newR.filter((r: any) => !oldR.some((o: any) => same(o, r)))
	const pool = fresh.length > 0 ? fresh : newR
	const std = pool.find((r: any) => r?.type === 'emoji' && r?.emoji)
	if (std) return String(std.emoji)
	return '❤️'
}

// Telegram reply → WhatsApp quoted reply. The reply_map tells us which WA
// message the replied-to Telegram message mirrors. Baileys accepts a minimal
// quoted stub ({key, message}) when the full original is unavailable.
function buildQuoted(msg: any, waJid: string, db: BridgeDB): any {
	const repliedId = msg.reply_to_message?.message_id
	if (!repliedId) return null
	try {
		const entry = db.getReplyMap(repliedId)
		if (!entry) return null
		let key: any = null
		try {
			key = JSON.parse(entry.wa_key_json)
		} catch {
			key = null
		}
		if (!key?.id) {
			key = { remoteJid: waJid, id: entry.wa_msg_id, fromMe: false }
		}
		const origText = msg.reply_to_message?.text || msg.reply_to_message?.caption || ''
		return { key, message: { conversation: origText.slice(0, 500) || '...' } }
	} catch {
		return null
	}
}

interface TgMedia {
	kind: 'image' | 'video' | 'video_note' | 'gif' | 'voice' | 'audio' | 'sticker' | 'document'
	buffer: Uint8Array
	fileName?: string
	mime?: string
}

// Bot API getFile refuses files over 20 MB ("file is too big") —
// pre-check file_size so doomed downloads fail fast with a specific
// notice instead of a generic one after a wasted attempt.
export const TG_DOWNLOAD_CAP_BYTES = 20_000_000

// Result of attempting a Telegram attachment download. null = the message
// carries no attachment node at all; otherwise media is set on success and
// null on failure, with label/bytes describing what didn't cross and
// tooLarge marking cap pre-check (or getFile "too big") skips.
export interface TgDownload {
	media: TgMedia | null
	label: string
	bytes: number | null
	tooLarge: boolean
}

export function formatBytes(n: number): string {
	const v = Math.max(0, Math.floor(n))
	if (v < 1024) return `${v} B`
	const units = ['KB', 'MB', 'GB'] as const
	let size = v / 1024
	let u = 0
	while (size >= 1024 && u < units.length - 1) {
		size /= 1024
		u++
	}
	return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[u]}`
}

function tgBytes(v: unknown): number | null {
	if (typeof v !== 'object' || v === null) {
		return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
	}
	return null
}

function sizeSuffix(bytes: number | null): string {
	return bytes != null ? ` (${formatBytes(bytes)})` : ''
}

// Topic notice for a failed Telegram download. tooLarge names the 20 MB
// cap and the fix (send it smaller / as a link); other failures name the
// attachment kind and size when known.
export function tgDownloadFailureLine(
	label: string,
	bytes: number | null,
	tooLarge: boolean,
): string {
	// Article keys off "Telegram" (consonant), not the label.
	if (tooLarge) {
		return `⚠️ A Telegram ${label}${
			sizeSuffix(bytes)
		} exceeds the 20 MB bot download limit — it didn't cross.`
	}
	return `⚠️ Couldn't download a Telegram ${label}${sizeSuffix(bytes)} — it didn't cross.`
}

async function downloadTgMedia(tg: Bot, msg: any): Promise<TgDownload | null> {
	try {
		let fileId: string | null = null
		let kind: TgMedia['kind'] = 'document'
		let label = 'attachment'
		let bytes: number | null = null
		let fileName: string | undefined
		let mime: string | undefined

		if (msg.sticker) {
			fileId = fileIdOf(msg.sticker)
			kind = 'sticker'
			label = 'sticker'
			bytes = tgBytes(msg.sticker.file_size)
			// WhatsApp only accepts WebP stickers. Flag video (.webm) and
			// animated (.tgs) ones here so buildWaContent() can relay them
			// as video/document instead.
			if (msg.sticker.is_video) {
				fileName = 'sticker.webm'
				mime = 'video/webm'
			} else if (msg.sticker.is_animated) {
				fileName = 'sticker.tgs'
				mime = 'application/x-tgs'
			} else {
				fileName = 'sticker.webp'
				mime = 'image/webp'
			}
		} else if (msg.photo?.length) {
			const best = msg.photo[msg.photo.length - 1]
			fileId = fileIdOf(best)
			kind = 'image'
			label = 'image'
			bytes = tgBytes(best.file_size)
		} else if (msg.video) {
			fileId = fileIdOf(msg.video)
			kind = 'video'
			label = 'video'
			bytes = tgBytes(msg.video.file_size)
			fileName = msg.video.file_name
			mime = msg.video.mime_type
		} else if (msg.video_note) {
			fileId = fileIdOf(msg.video_note)
			kind = 'video_note'
			label = 'video note'
			bytes = tgBytes(msg.video_note.file_size)
		} else if (msg.animation) {
			fileId = fileIdOf(msg.animation)
			kind = 'gif'
			label = 'GIF'
			bytes = tgBytes(msg.animation.file_size)
			fileName = msg.animation.file_name
			mime = msg.animation.mime_type
		} else if (msg.voice) {
			fileId = fileIdOf(msg.voice)
			kind = 'voice'
			label = 'voice message'
			bytes = tgBytes(msg.voice.file_size)
		} else if (msg.audio) {
			fileId = fileIdOf(msg.audio)
			kind = 'audio'
			label = 'audio'
			bytes = tgBytes(msg.audio.file_size)
			mime = msg.audio.mime_type
		} else if (msg.document) {
			fileId = fileIdOf(msg.document)
			kind = 'document'
			label = msg.document.file_name ? `document "${msg.document.file_name}"` : 'document'
			bytes = tgBytes(msg.document.file_size)
			fileName = msg.document.file_name
			mime = msg.document.mime_type
		} else {
			return null
		}

		const fail = (tooLarge: boolean): TgDownload => ({ media: null, label, bytes, tooLarge })
		if (bytes != null && bytes > TG_DOWNLOAD_CAP_BYTES) return fail(true)
		if (!fileId) return fail(false)
		const buffer = await downloadTgFile(tg, fileId)
		if (buffer === 'too-large') return fail(true)
		if (!buffer) return fail(false)
		return { media: { kind, buffer, fileName, mime }, label, bytes, tooLarge: false }
	} catch {
		return null
	}
}

function fileIdOf(f: any): string | null {
	if (!f) return null
	if (typeof f === 'string') return f
	if (typeof f.file_id === 'string') return f.file_id
	return null
}

// Best-effort ⚠️ notice to the affected topic so a relay failure is visible
// where the user looks, not just in server logs. Never throws and never
// loops (the message handler ignores the bot's own messages).
async function notifyTopic(
	tg: Bot,
	limiter: RateLimiter,
	topicId: number,
	line: string,
): Promise<void> {
	try {
		await limiter.enqueue(() =>
			tg.api.sendMessage(String(Deno.env.get('TELEGRAM_SUPERGROUP_ID')), line, {
				message_thread_id: topicId,
			})
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

async function downloadTgFile(tg: Bot, fileId: string): Promise<Uint8Array | 'too-large' | null> {
	try {
		const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
		const file = await tg.api.getFile(fileId)
		if (!file.file_path) return null
		const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
		if (!res.ok) return null
		const declared = Number(res.headers.get('content-length'))
		if (Number.isFinite(declared) && declared > TG_DOWNLOAD_CAP_BYTES) {
			await res.body?.cancel().catch(() => {})
			return 'too-large'
		}
		const buf = new Uint8Array(await res.arrayBuffer())
		if (buf.length > TG_DOWNLOAD_CAP_BYTES) return 'too-large'
		return buf
	} catch (e) {
		// Second layer behind the file_size pre-check (size can be absent
		// on some nodes): getFile itself refuses >20 MB files.
		const msg = (e as { description?: unknown; message?: unknown })?.description ??
			(e as { message?: unknown })?.message ?? ''
		if (/too big|too large|file_too_big/i.test(String(msg))) return 'too-large'
		return null
	}
}
