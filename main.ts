import { Baileys, locale, proto, server } from './map.js'

proto() // load prototypes
locale() // load locales
const bot = new Baileys('settings/auth')
// auth/ contains auth info to login without scan QR Code again

bot.connect()
server(bot) // start express server

process // "anti-crash" to handle lib instabilities
	.on('unhandledRejection', (e: Error) => console.error(`Unhandled Rej: ${e.stack}`))
	.on('uncaughtException', (e) => console.error(`Uncaught Excep.: ${e?.stack}`))
	.on('uncaughtExceptionMonitor', (e) => console.error(`Uncaught Excep.M.: ${e?.stack}`))
