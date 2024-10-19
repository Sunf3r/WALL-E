import { Cmd, CmdCtx } from '../../map.js'
import translate from 'google-translate'

export default class extends Cmd {
	constructor() {
		super({
			aliases: ['t'],
			cooldown: 5,
		})
	}

	async run({ bot, msg, args, sendUsage, t }: CmdCtx) {
		if (!args[1]) return sendUsage()

		const toLang = args.shift()
		try {
			const output = await translate(args.join(' '), { to: toLang })

			const text = `*[🌐] - ${t('translate.desc')}*\n` +
				`*${output?.from.language.iso}  ➟  ${toLang}*\n` +
				output?.text.encode()

			bot.send(msg, text)
		} catch (e: any) {
			print(e)
			sendUsage()
		}
		return
	}
}
