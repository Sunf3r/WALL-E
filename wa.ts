import { folderHandler, loadCmd, loadEvent } from './util/client.ts'
import { Client, LocalAuth } from 'wa'
import proto from './util/proto.ts'

proto() // load prototypes
const bot = new Client({
	authStrategy: new LocalAuth({ dataPath: 'conf', clientId: 'walle' }),
	// auth path = conf/session/
	puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
})

const cwd = Deno.cwd()
folderHandler(cwd + '/event', loadEvent, bot) // load all events
folderHandler(cwd + '/cmd', loadCmd, bot) // load all commands

// bot.initialize()
