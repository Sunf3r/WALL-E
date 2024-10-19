import type { CmdContext } from '../../Typings';
import { execSync } from 'child_process';
import Command from '../../Core/Command';

export default class extends Command {
	constructor() {
		super({
			aliases: ['exec', 'run', 'execute'],
			access: { onlyDevs: true },
		});
	}

	async run(ctx: CmdContext) {
		const startTime = Date.now();
		const initialRam = (process.memoryUsage().rss / 1024 / 1024).toFixed(2); // DENO

		let title;
		let output;

		try {
			output = execSync(ctx.args.join(' ') || '').toString();

			title = '[✅] Result'; // Msg title
		} catch (error) {
			title = '[❌] Fail'; // Msg title
			output = String(error); // process return
		} finally {
			output = output!.trim();

			// RAM usage when the process ends
			const currentRam = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);

			const text = `*[⏰] Duration:* ${Date.now() - startTime}ms\n` +
				`*[🎞️] RAM:* ${initialRam}/${currentRam}MB\n` +
				`*${title}:*\n\n ` + '```\n' + output + '```';

			return await ctx.bot.send(ctx.msg, text);
		}
	}
}
