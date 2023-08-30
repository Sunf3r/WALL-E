import { CmdContext } from '../../Typings';
import Command from '../../Core/Command';
import translate from 'google-translate';

export default class extends Command {
	constructor() {
		super({
			aliases: ['t'],
			cooldown: 5,
		});
	}

	async run(ctx: CmdContext) {
		if (!ctx.args[1]) return ctx.bot.react(ctx.msg, '❌');

		const options = {
			to: ctx.args.shift(),
		};
		const t = await translate(ctx.args.join(' '), options);

		const msg = '*[🌐] Google Translate*\n' +
			`*${t.from.language.iso}  ➟  ${options.to}*\n` +
			'```\n' + t.text + '```';

		return await ctx.bot.send(ctx.msg, msg);
	}
}
