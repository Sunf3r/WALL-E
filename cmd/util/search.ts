import { Cmd, CmdCtx } from '../../map.js'
import googleThis from 'googlethis'
import * as g from 'google-sr'

export default class extends Cmd {
	constructor() {
		super({
			alias: ['se', 'google'],
			cooldown: 5,
		})
	}

	async run({ args, bot, msg, user, sendUsage, t }: CmdCtx) {
		if (!args[0]) return sendUsage()

		const query = await g.search({
			query: args.join(' ').trim(),
			safeMode: false,
			filterResults: [ // filter google results for these options
				g.ResultTypes.DictionaryResult,
				g.ResultTypes.TranslateResult,
				g.ResultTypes.CurrencyResult,
				g.ResultTypes.SearchResult,
				g.ResultTypes.TimeResult,
			],
			requestConfig: {
				params: {
					hl: user.lang, // search content on user's language
					lr: `lang_${user.lang}`.toLowerCase(),
					cr: 'countryBR',
				},
			},
		})

		if (!query) return bot.send(msg, t('search:notFound'))

		let text = '' // it's what the bot will say
		let pronunciation = ''
		query.length = 3 // limit to 3 results

		const responseFunctions = {
			SEARCH(r: g.SearchResultNode) {
				const { title, link, description } = r // websites

				text += `*${title}:*\n> ${description} (${link})`
			},
			async DICTIONARY(r: g.DictionaryResultNode) {
				const { word, phonetic, audio } = r // dictionary result

				if (audio) pronunciation = audio // word pronunciation

				const moreInfo = await googleThis.search(word, {
					parse_ads: false, // searches for more info
					safe: false,
					additional_params: { hl: user.lang },
				})

				const { title, type, description, metadata } = moreInfo?.knowledge_panel

				text += `*${title || word}* (${type || phonetic})`
				// e.g.: *Donald Trump* (45th U.S. President)

				if (description) text += `\n> ${description}\n`
				// > Donald John Trump is bla bla bla

				for (const { title: key, value } of metadata) {
					text += `\n*> ${key}*: ${value}`
				}
			},
			CURRENCY(r: g.CurrencyResultNode) {
				const { formula } = r

				text += `*${formula}*`

				query.length = 1 // only one result is enough
			},
			TIME(r: g.TimeResultNode) {
				const { location, time, timeInWords, type } = r

				text += `*${time}* - ${timeInWords.split('\n')[0]} (${location})`

				query.length = 1
			},
			TRANSLATE(r: g.TranslateResultNode) {
				const { source: src, translation: res } = r

				text += `${src.language}  ➟  ${res.language}\n`
				text += `*${res.text}* `

				if (res.pronunciation) text += `(${res.pronunciation})`
				// word pronunciation if available

				query.length = 1
			},
		}

		for (const result of query) {
			text += '\n\n'

			await responseFunctions[result.type as 'SEARCH'](result as any)
		}

		await bot.send(msg, text.trim())

		if (pronunciation) { // then send word pronunciation
			bot.send(msg, {
				audio: { url: pronunciation },
				mimetype: 'audio/mpeg',
				fileName: 'pronunciation.mp3',
				ptt: true,
			})
		}
		return
	}
}
