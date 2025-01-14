import { Cmd, CmdCtx, prisma } from '../../map.js'

export default class extends Cmd {
	constructor() {
		super({
			alias: ['re', 'lembrete'],
			subCmds: ['list'],
		})
	}

	async run({ bot, user, msg, args, sendUsage }: CmdCtx) {
		if (args[0] === this.subCmds[0]) { // list
			const list = await prisma.reminders.findMany({ where: { author: user.id } }) // all user reminders

			const pendingReminders = list
				.filter((i) => !i.isDone) // active reminders
				.sort((a, b) => Number(a.remindAt) - Number(b.remindAt)) // order by duration ASC
				.map((l, i) => {
					let duration = (Number(l.remindAt) - Date.now()).duration()

					return `${i + 1}. \`${l.msg}\` in *${duration}*`
				})
				.join('\n')

			const doneReminders = list
				.filter((i) => i.isDone) // completed reminders
				.sort((a, b) => Number(a.remindAt) - Number(b.remindAt))
				.map((l, i) => `${i + 1}. \`${l.msg}\``)
				.join('\n')

			let text = ''

			if (pendingReminders[0]) text += `*Reminders list:*\n${pendingReminders}\n\n`
			if (doneReminders[0]) text += `*Done reminders:*\n${doneReminders}`

			bot.send(msg, text.trim())
			return
		}
		if (!args[1]) return sendUsage()

		const matchMs = args.join(' ').toMs() // convert string to ms
		// '1s' => 1000ms

		// sendUsage if time is invalid, less than 1m or more than 1y
		if (!matchMs[0] || matchMs[0] <= 59_999 || matchMs[0] >= 31_536_000_000) return sendUsage()

		const time = Date.now() + matchMs[0] // remind at this moment

		args = args
			.filter((a) => !matchMs[1].includes(a)) // remove time from remind text

		await prisma.reminders.create({
			data: { // create remind
				author: user.id,
				chat: msg.chat,
				msg: args.join(' ').trim().slice(0, 100), // remove unnecessary spaces from str
				remindAt: String(time),
			},
		})

		bot.react(msg, 'ok')
	}
}
