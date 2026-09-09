// Chat and group helpers - names, topics and membership lines in one place.
//
// Each WhatsApp chat mirrors to its own forum topic - this resolves display
// names (with caching), creates topics through the flood queue and relays
// membership and subject changes as service lines.
import { cacheGroupName, groupNameCache, relayCtx, tgCall } from './state.ts'
import { phoneOf } from './text.ts'
import bot from '@plugin/bot.ts'

export async function resolveChatName(
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
				cacheGroupName(jid, meta.subject)
				return meta.subject
			}
		} catch {
			// fall through to pushName/phone
		}
		const fallback = pushName || jid.split('@')[0]
		cacheGroupName(jid, fallback)
		return fallback
	}
	return pushName || phoneOf(jid) || jid.split('@')[0]
}

export async function createForumTopic(displayName: string, _isGroup: boolean): Promise<number> {
	const { tg, supergroupId } = relayCtx
	if (!tg) throw new Error('Telegram bot not initialized')
	const name = (displayName || 'Unknown').replace(/[\n\r]+/g, ' ').trim().slice(0, 128) ||
		'Unknown'
	// Topic creation is a Bot API call like any other - it goes through the
	// limiter so a burst of new chats can't flood the supergroup budget.
	const topic = await tgCall(() => tg!.api.createForumTopic(supergroupId, name), 'new-topic')
	return topic.message_thread_id
}

// Ensure a forum topic mapping exists - creates or refreshes it, updates
// activity and returns null when muted so the caller skips silently.
export async function ensureTopicMapping(
	jid: string,
	displayName: string,
	chatType: '1:1' | 'group',
	isGroup: boolean,
): Promise<{ topicId: number } | null> {
	const { db } = relayCtx
	if (!db) return null
	let mapping = db.getByJid(jid)
	if (!mapping || mapping.archived) {
		const freshTopicId = await createForumTopic(displayName, isGroup)
		mapping = db.getOrCreate(jid, freshTopicId, displayName, chatType)
	} else {
		if (mapping.display_name !== displayName) {
			mapping = db.getOrCreate(jid, mapping.telegram_topic_id, displayName, chatType)
		} else {
			db.updateLastActive(jid)
		}
	}
	if (mapping.muted) return null
	return { topicId: mapping.telegram_topic_id }
}

// Group membership changes -> service lines in the topic.
export async function handleGroupParticipants(upd: {
	id: string
	participants: (string | { id?: string })[]
	action: string
}): Promise<void> {
	const { db, limiter, tg, supergroupId } = relayCtx
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
		await tgCall(() =>
			tg!.api.sendMessage(supergroupId, line!, {
				message_thread_id: mapping.telegram_topic_id,
			}), 'service-line')
	} catch (e) {
		console.error('[BRIDGE] failed to relay group participants:', e)
	}
}

// Group subject changes -> rename mapping + topic (best effort).
export async function handleGroupUpdates(
	updates: Partial<{ id: string; subject: string }>[],
): Promise<void> {
	const { db, limiter, tg, supergroupId } = relayCtx
	if (!db || !limiter || !tg) return
	for (const u of updates || []) {
		try {
			if (!u?.id || !u.subject) continue
			const mapping = db.getByJid(u.id)
			if (!mapping || mapping.archived || mapping.muted) continue
			if (mapping.display_name === u.subject) continue
			cacheGroupName(u.id, u.subject)
			db.getOrCreate(u.id, mapping.telegram_topic_id, u.subject, mapping.chat_type)
			await tgCall(() =>
				tg!.api.editForumTopic(supergroupId, mapping.telegram_topic_id, {
					name: u.subject!.slice(0, 128),
				}).catch(() => false), 'edit-topic')
		} catch (e) {
			console.error('[BRIDGE] failed to relay group update:', e)
		}
	}
}
