import { devs, prefix } from '../../config.json';
import * as utils from '../../Core/Utils';
import BotClient from '../../Client';
import { inspect } from 'util';

export default class implements Command {
	public aliases = ['e'];
	public access = {
		dm: true,
		groups: true,
		onlyDevs: true,
	};

	run = async (bot: BotClient, msg: Msg, args: string[]) => {
		const { getQuoted, convertMsgData } = utils;

		const startTime = Date.now(),
			initialRam = (process.memoryUsage().rss / 1024 / 1024).toFixed(2); // DENO

		const code = args.join(' ');
		let evaled, title;

		try {
			// Roda o eval em uma função assíncrona se ele conter a palavra "await"
			if (code.includes('await')) evaled = await eval(`(async () => { ${code} })()`);
			else evaled = await eval(code);

			title = '🎉 Retorno'; // Título da msg
			evaled = !evaled ? '- Sem retorno.' : inspect(evaled, { depth: null }); // Retorno do eval
		} catch (error) {
			title = '❌ Falha'; // Título da msg
			evaled = error; // Retorno do eval
		} finally {
			// Consumo de RAM ao final do eval
			const currentRam = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);

			const text = `⏰ *Duração:* ${Date.now() - startTime}ms\n` +
				`🎞️ *RAM:* ${initialRam}/${currentRam}MB\n` +
				`*${title}:*\n\n ` + '```\n' + evaled + '```';

			return await bot.send(msg.chat, text, msg.raw);
		}
	};
}