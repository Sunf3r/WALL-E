import settings from '../settings/settings.json' with { type: 'json' }
import { prisma } from '../map.js'
import express from 'express'
const app = express()

/** Reminder
 * This plugin will check evert 5s if there is a pending reminder
 * and when its time gets over, sends reminder request to main thread
 * so the bot will remind the user on another process
 */

app
	.use(express.json()) // use content-type: json
	.get('/ping', async (_req, res) => res.sendStatus(200))
	.listen(
		settings.api.reminderPort,
		() => console.log(`Reminder ready on port ${settings.api.reminderPort}!`),
	)

setInterval(async () => {
	let reminders = await prisma.reminders.findMany({
		orderBy: { remindAt: 'asc' },
		where: { isDone: null },
	})

	reminders = reminders.filter((r) => Number(r.remindAt) < Date.now())

	for (const r of reminders) {
		console.log(r)

		await fetch(`http://localhost:${settings.bot.port}/reminder`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(r),
		})
			.then(() =>
				prisma.reminders.update({
					where: { id: r.id },
					data: { isDone: true },
				})
			)
			.catch((e) => console.log(r, e.message))
	}
}, 1_000 * 5)
