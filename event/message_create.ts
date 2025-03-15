import { Client, Message, MessageMedia } from 'wa'

export default async function (bot: Client, msg: Message) {
	const chat = await msg.getChat()

	if (msg.body === 'deno') {
		// send back "pong" to the chat the message was sent in
		bot.sendMessage(chat.id._serialized, 'hello from denooo')
		if (msg.hasMedia) {
			const media = await msg.downloadMedia()

			const newMedia = new MessageMedia(media.mimetype, media.data)
			bot.sendMessage(chat.id._serialized, newMedia, {
				sendMediaAsSticker: true,
			})
		}
	}
}
