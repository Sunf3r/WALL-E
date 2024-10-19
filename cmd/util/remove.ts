import { Cmd, CmdCtx, emojis, isVisual, makeTempFile, runCode } from '../../map.js'
import { readFile } from 'fs/promises'

export default class extends Cmd {
	constructor() {
		super({
			alias: ['rm'],
			cooldown: 5,
		})
	}

	async run({ bot, msg, sendUsage, t }: CmdCtx) {
		if (!isVisual(msg.type) && !isVisual(msg.quoted?.type)) return sendUsage()

		let target = isVisual(msg.type) ? msg : msg.quoted
		// choose between msg media or quoted msg media
		let buffer = await bot.downloadMedia(target)

		if (!Buffer.isBuffer(buffer)) return bot.send(msg, t('sticker.nobuffer'))
		await bot.react(msg, 'loading')

		const file = await makeTempFile(buffer, 'rmbg_', '.webp')
		// create temporary file

		await runCode({ // execute python background remover plugin on
			file: 'plugin/removeBg.py', // a separate thread
			code: `${file} ${file}.png`,
			// cli args
		})
		buffer = await readFile(`${file}.png`) || buffer
		// read new file

		bot.send(msg.chat, { caption: emojis['sparkles'], image: buffer })
		return
	}
}
