// WhatsApp media download - fetch attachments off the shared socket.
//
// Media nodes carry only metadata until downloaded - this resolves the node
// kind, guards missing urls and returns buffers plus failure labels so the
// caller can notify the topic instead of dropping silently.
import { downloadMediaMessage, type proto } from 'baileys'
import { waBytes } from './media-utils.ts'
import { logger } from '@util/proto.ts'
import { unwrap } from './text.ts'
import bot from '@plugin/bot.ts'

export interface WaMedia {
	kind: 'image' | 'video' | 'round' | 'gif' | 'voice' | 'audio' | 'sticker' | 'document'
	buffer: Uint8Array
	mime?: string
	fileName?: string
	ptt?: boolean
}

// Result of attempting a WhatsApp attachment download. null = the message
// carries no media node at all; otherwise media is set on success and null
// on failure, with label/bytes describing what didn't cross (from the
// node's fileLength, which Baileys exposes as number | Long | string).
export interface WaDownload {
	media: WaMedia | null
	label: string
	bytes: number | null
}

export async function downloadWaMedia(m: proto.IWebMessageInfo): Promise<WaDownload | null> {
	try {
		const raw = unwrap(m.message)
		if (!raw) return null

		let kind: WaMedia['kind'] | null = null
		let label = 'attachment'
		let node: any = null
		if (raw.imageMessage) {
			kind = 'image'
			label = 'image'
			node = raw.imageMessage
		} else if (raw.ptvMessage) {
			// Round video-note messages arrive as ptvMessage, not videoMessage.
			kind = 'round'
			label = 'video note'
			node = raw.ptvMessage
		} else if (raw.videoMessage) {
			// GIFs are videoMessages with the gifPlayback flag.
			const isGif = !!raw.videoMessage.gifPlayback
			kind = isGif ? 'gif' : 'video'
			label = isGif ? 'GIF' : 'video'
			node = raw.videoMessage
		} else if (raw.audioMessage) {
			const isVoice = !!raw.audioMessage.ptt
			kind = isVoice ? 'voice' : 'audio'
			label = isVoice ? 'voice message' : 'audio'
			node = raw.audioMessage
		} else if (raw.stickerMessage) {
			kind = 'sticker'
			label = 'sticker'
			node = raw.stickerMessage
		} else if (raw.documentMessage) {
			kind = 'document'
			label = documentLabel(raw.documentMessage)
			node = raw.documentMessage
		} else {
			return null
		}
		const bytes = waBytes(node?.fileLength)
		const fail = (): WaDownload => ({ media: null, label, bytes })
		if (!node?.url && !node?.directPath) return fail()

		const buffer = await downloadMediaMessage(
			m as any,
			'buffer',
			{},
			{ reuploadRequest: bot.sock.updateMediaMessage, logger },
		).catch(() => null) as Buffer | Uint8Array | null
		if (!buffer) return fail()

		return {
			media: {
				kind,
				buffer: new Uint8Array(buffer),
				mime: node.mimetype,
				fileName: node.fileName,
				ptt: node.ptt,
			},
			label,
			bytes,
		}
	} catch {
		return null
	}
}

export function documentLabel(node: any): string {
	return node?.fileName ? `document "${node.fileName}"` : 'document'
}
