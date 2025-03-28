import { Baileys, checkPermissions, CmdCtx, delay, getCtx } from '../../map.js'
import { type proto } from 'baileys'
import { getFixedT } from 'i18next'

// messages upsert event
export default async function (bot: Baileys, raw: { messages: proto.IWebMessageInfo[] }, e: str) {
	// raw.messages = []

	// sometimes you can receive more then 1 message per trigger, so use for
	for (const m of raw.messages) {
		if (!m?.message) continue

		// get abstract msg obj
		const context = await getCtx(m, bot)
		if (!context.msg) continue
		const { msg, args, cmd, group, user } = context

		if (!user || !msg) return
		if (group) {
			group.msgs.add(msg.key.id!, msg)
			if (!msg.isBot) group.countMsg(user.id)
			// count msgs with cool values for group msgs rank cmd
		} else user.msgs.add(msg.key.id!, msg)

		// run functions waiting for msgs (waitFor)
		if (bot.cache.wait.has(e)) {
			bot.cache.wait.forEach((f: Function) => {
				try {
					f(bot, msg, user, group)
				} catch (e) {
					console.error(e, `EVENT/${e}/waitFor`)
				}
			})
		}

		if (!cmd) continue
		// get locales function
		const t = getFixedT(user.lang)

		// Check cmd permissions
		const auth = checkPermissions(cmd, user, group)
		if (auth !== true) {
			if (auth === 'nodb') bot.send(msg, t('events.nodb'))
			bot.react(msg, auth)
			continue // you got censored OOOOMAGAAAA
		}

		const ctx: CmdCtx = {
			sendUsage, // sends cmd help menu
			group,
			args,
			user,
			bot,
			cmd,
			msg,
			t,
		}

		const now = Date.now()
		const cooldown = cmd.cooldown * 1_000
		if (user.lastCmd.delay > now) {
			user.lastCmd.delay += cooldown
			const timeout = user.lastCmd.delay - now

			await bot.send(msg, t('events.cooldown', { time: timeout.duration(true) }))
			// warns user about cooldown
			if (timeout / 2 < cooldown) await bot.react(msg, 'clock')

			await delay(timeout)
			// wait until it gets finished
		} else user.lastCmd.delay = now + cooldown

		user.addCmd() // 1+ on user personal cmds count

		// start typing (expires after about 10 seconds.)
		// bot.sock.sendPresenceUpdate('composing', msg.chat);

		Promise.resolve(cmd.run!(ctx))
			.catch(async (e) => {
				console.error(e, `EVENT/${e}`)
				await bot.send(msg, `[⚠️] ${e?.message || e}`)
				bot.react(msg, 'x')
			})

		// sendUsage: sends cmd help menu
		async function sendUsage() {
			args[0] = cmd.name

			await bot.cache.cmds.get('help').run(ctx)
			bot.react(msg, '🤔')
			return
		}
	}
	return
}
