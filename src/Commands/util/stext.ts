import { getStickerAuthor } from '../../Core/Utils';
import { CmdContext } from '../../Typings';
import Sticker from 'wa-sticker-formatter';
import Command from '../../Core/Command';
import Jimp from 'jimp';

export default class extends Command {
	constructor() {
		super({
			aliases: ['st', 'text'],
		});
	}

	async run({ msg, args, group, bot }: CmdContext): Promise<any> {
		if (!args[0]) return;

		return await new Promise(async (res) => {
			const img = new Jimp(256, 256);
			const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);

			img.print(
				font,
				10,
				10,
				{
					text: args.join(' '),
					alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
					alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE,
				},
				240,
				240,
			);

			const metadata = new Sticker(await img.getBufferAsync(Jimp.MIME_PNG), {
				...getStickerAuthor(msg, group),
				type: '',
				categories: ['🎉'],
				id: '12345',
				quality: 50,
			});

			await bot.send(msg.chat, await metadata.toMessage());
			return res(true);
		});
	}
}