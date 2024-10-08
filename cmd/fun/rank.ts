import { Cmd, CmdCtx, GroupMsg, prisma, User } from '../../map.js'

export default class extends Cmd {
	constructor() {
		super({
			access: {
				dm: false,
				groups: true,
			},
		})
	}

	async run({ bot, msg, group, t }: CmdCtx) {
		let text = `*[🏆] - ${group!.name}'s Rank*\n\n`

		let msgs = await group!.getCountedMsgs() as GroupMsg[]

		// same as SQL "ORDERBY count DESC"
		msgs = msgs.sort((a, b) => b.count - a.count)

		for (const i in msgs) {
			const { author, count } = msgs[i]

			let user: User = bot.cache.users.get(author)

			if (!user) { // find user on db if it's not on cache
				user = await prisma.users.findUnique({
					where: { id: author },
				}) as User
			}

			text += `*${Number(i) + 1}.* ${user?.name || author}: *${count}* messages\n`
		}

		bot.send(msg, text)
		return
	}
}
