// WhatsApp text helpers - unwrap envelopes and resolve mentions in one place.
//
// View-once and ephemeral wrappers hide the real payload, and Telegram cannot
// resolve WhatsApp identities - these pure helpers peel wrappers, extract
// text and annotate mentions so downstream senders stay simple.
import { findKey } from '@util/functions.ts'
import type { proto } from 'baileys'

// Peel view-once / ephemeral wrappers so media underneath is reachable.
export function unwrap(message: proto.IMessage | undefined | null): any {
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

export function phoneOf(jid: string | undefined | null): string {
	if (!jid) return ''
	const user = jid.split('@')[0].split(':')[0]
	return user ? `+${user}` : ''
}

export function getMsgText(message: proto.IMessage): string {
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
// Same direct top-level scan as getQuoteInfo - never a deep search.
export function mentionedJidsOf(raw: any): string[] {
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
// "hi @John (+1555...)". Pairs @tokens in order with the JID list (which is
// how WhatsApp orders them); tokens already containing the number and
// unresolvable JIDs pass through untouched. Runs BEFORE entity parsing so
// formatting offsets stay consistent.
export function annotateMentions(text: string, mentionedJids: string[]): string {
	if (!text || mentionedJids.length === 0) return text
	const phones = mentionedJids.map(jidPhone)
	let i = 0
	// Trailing punctuation (,@John, ...) stays outside the token so the phone
	// lands next to the name: "@John, hi" -> "@John (+...), hi".
	return text.replace(/@[^@\s.,;:!?)]+/g, (tok) => {
		if (i >= phones.length) return tok
		const phone = phones[i++]
		if (!phone) return tok
		if (tok.replace(/\D/g, '').endsWith(phone.slice(-7))) return tok
		return `${tok} (${phone})`
	})
}
