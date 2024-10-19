import { CmdContext } from '@Typings/index';
import Command from '@Classes/Command';

export default class extends Command {
	constructor() {
		super({
			aliases: ['p'],
		});
	}
	async run({ bot, msg }: CmdContext) {
		const time = Date.now();
		await bot.send(msg.chat, 'Pinging...');

		return await bot.send(msg, `Ping: *${Date.now() - time}ms*`);
	}
}
