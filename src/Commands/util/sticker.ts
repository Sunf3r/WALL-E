import { extractMetadata, Sticker } from 'wa-sticker-formatter';
import { getStickerAuthor } from '../../Core/Utils';
import { CmdContext, Msg } from '../../Typings';
import Command from '../../Core/Command';
import Bot from '../../Core/Bot';

export default class extends Command {
	constructor() {
		super({
			aliases: ['s', 'makesticker'],
			cooldown: 0,
		});
	}

	async run({ msg, bot, group }: CmdContext) {
		let stickerTypes = ['rounded', 'full', 'crop', 'circle'];
		let targetMsg: Msg;

		if (msg.quoted && msg.quoted.isMedia) targetMsg = msg.quoted;
		else targetMsg = msg;

		const buffer = await bot.downloadMedia(targetMsg)
			.catch(() => {});
		if (!buffer) return;

		switch (targetMsg.type) {
			case 'videoMessage':
				stickerTypes = ['full', 'rounded'];
				break;
			case 'stickerMessage':
				await bot.send(msg, await this.sendMetadata(buffer));
		}

		for (const type of stickerTypes) {
			const metadata = new Sticker(buffer!, {
				...getStickerAuthor(msg, group),
				type,
				quality: 60,
			});

			await bot.send(msg.chat, await metadata.toMessage());
		}
		return;
	}

	sendMetadata = async (sticker: Buffer) => {
		const {
			'sticker-pack-publisher': publisher = '',
			'sticker-pack-name': packName = '',
			emojis = '[]',
			'sticker-pack-id': packId = '',
		} = await extractMetadata(sticker);

		const caption = `*꒷︶꒷꒦ Sticker Info ꒷꒦︶꒷*\n\n` +
			`*Publisher:* ${publisher}\n` +
			`*Pack:* ${packName}\n` +
			`*Emojis:* ${emojis}\n` +
			`*ID:* ${packId}`;

		return { caption, image: sticker };
	};
}
