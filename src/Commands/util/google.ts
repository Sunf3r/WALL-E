import { CmdContext } from '../../Core/Typings/types.js';
import Command from '../../Core/Classes/Command.js';
import google from 'googlethis';

export default class extends Command {
	constructor() {
		super({
			aliases: ['search', 'g'],
		});
	}

	async run({ args, bot, msg, user, sendUsage, t }: CmdContext) {
		if (!args[1]) return sendUsage();

		const options = {
			page: 0,
			safe: false, // Safe Search
			parse_ads: false, // If set to true sponsored results will be parsed
			additional_params: {
				/* add additional parameters here,
                see https://moz.com/blog/the-ultimate-guide-to-the-google-search-parameters
                and https://www.seoquake.com/blog/google-search-param/
                */
				hl: user.lang,
			},
		};

		let img = '';
		let source = ''; // data & img links
		const text: str[] = []; // it's what the bot will say
		const query = await google.search(args.join(' ').trim(), options);

		if (!query) return bot.send(msg, t('search:notFound'));

		const responseFunctions = {
			knowledge_panel() {
				const { title, type, description, url, metadata, images } = query.knowledge_panel;
				const boldTitle = `*${title}*`;
				source = `URL: ${url}`;

				text.push(
					`${boldTitle} (${type})\n\n`, // title
					description || '',
				);

				for (const data of metadata) {
					text.push(
						'\n',
						data.title,
						': ',
						data.value,
						'\n',
					);
				}

				if (images) {
					img = images[0].url;
					source += `\nImage source: ` + images[0].source;
				}
			},
			videos() {
				for (let i = 0; i < 3; i++) {
					const { title, author, duration, url } = query.videos[i];

					text.push(
						`video: (${title} - ${author})[${url}] [${duration}]`,
					);
				}
			},
			results() {
				for (let i = 0; i < 3; i++) {
					const { title, description, is_sponsored, url } = query.results[i];

					if (is_sponsored) return;

					text.push(
						'\n', // break line
						`[${title}](${url}):`, // title hyperlink
						'\n',
						description || '',
						'\n',
					);
				}
			},
		};

		for (const [key, value] of Object.entries(query)) {
			if (value) responseFunctions[key as 'videos'];
		}

		text.push(source);

		return bot.send(msg, { text: text.join(' '), image: { url: img } });
	}
}
