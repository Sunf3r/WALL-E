import type { CmdContext } from '../../Typings';
import Command from '../../Core/Command';
import { inspect } from 'util';

export default class extends Command {
	constructor() {
		super({
			aliases: ['e'],
			access: {
				onlyDevs: true,
			},
		});
	}

	async run(ctx: CmdContext) {
		const startTime = Date.now();
		const initialRam = (process.memoryUsage().rss / 1024 / 1024).toFixed(2); // DENO

		const code = ctx.args.join(' ');
		let evaled, title;

		try {
			// Run eval in async function if it contains 'await'
			evaled = code.includes('await')
				? await eval(`(async () => { ${code} })()`)
				: await eval(code);

			title = '[✅] Return'; // Msg title
			evaled = inspect(evaled, { depth: null }); // eval result
		} catch (error) {
			title = '[❌] Fail'; // Msg title
			evaled = error;
		} finally {
			// RAM usage when the eval ends
			const currentRam = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);

			const text = `*[⏰] Duration:* ${Date.now() - startTime}ms\n` +
				`*[🎞️] RAM:* ${initialRam}/${currentRam}MB\n` +
				`*${title}:*\n\n ` + '```\n' + evaled + '```';

			return await ctx.bot.send(ctx.msg, text);
		}
	}
}
