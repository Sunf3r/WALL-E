import { Cmd, CmdCtx, delay, isValidPositiveIntenger } from '../../map.js'

export default class extends Cmd {
	constructor() {
		super({
			cooldown: 10,
			subCmds: ['reverse'],
		})
	}

	async run({ bot, msg, args, group, sendUsage, t }: CmdCtx) {
		group = group!
		let disclaimerMsg
		const amount = Number(args[0]) // amount of msgs to be deleted for everyone-

		if (amount === 0) return bot.send(msg, t('clean.noAmount'))

		if (!isValidPositiveIntenger(amount)) return sendUsage()

		if (group.msgs.size < amount) {
			disclaimerMsg = await bot.send(msg, t('clean.deleted', { msgsSize: group.msgs.size }))
		}
		// the bot can only delete up to 200 cached msgs

		let msgs = group.msgs.map((m) => m.key)
			.reverse()
			.slice(1, amount + 1)

		if (this.subCmds[0] === args[1]) msgs = msgs.reverse()
		// it will delete latest msgs first

		for (const i in msgs) {
			if (Number(i) % 10 === 0 && i !== '0') await delay(1_000)
			await bot.deleteMsg(msgs[i]) // delete msg for everyone
			group.msgs.delete(msgs[i].id) // delete it from cache

			await delay(500)
		}

		if (disclaimerMsg) { // delete disclaimer msg
			await bot.deleteMsg(disclaimerMsg.msg)
			group.msgs.delete(disclaimerMsg.msg.key.id)
		}
		bot.deleteMsg(msg) // delete cmd msg
		group.msgs.delete(msg.key.id)
		return
	}
}
