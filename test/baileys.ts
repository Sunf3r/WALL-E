import {
	DisconnectReason,
	makeCacheableSignalKeyStore,
	makeWASocket,
	useMultiFileAuthState,
} from 'baileys'
import pino from 'npm:pino'

const logger = pino.default({
	level: 'silent',
	transport: {
		target: 'pino-pretty',
		options: { ignore: 'pid,hostname' },
	},
})

connectToWhatsApp()
async function connectToWhatsApp() {
	const { state, saveCreds } = await useMultiFileAuthState('settings/auth')
	const version = [2, 3000, 1019707846]

	const sock = makeWASocket({
		// can provide additional config here
		printQRInTerminal: true,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		version,
	})

	sock.ev.on('connection.update', (update) => {
		const { connection, lastDisconnect } = update
		if (connection === 'close') {
			const shouldReconnect = lastDisconnect.error?.output?.statusCode !==
				DisconnectReason.loggedOut
			console.log(
				'connection closed due to ',
				lastDisconnect.error,
				', reconnecting ',
				shouldReconnect,
			)
			// reconnect if not logged out
			if (shouldReconnect) {
				connectToWhatsApp()
			}
		} else if (connection === 'open') {
			console.log('opened connection')
		}
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('messages.upsert', (m) => {
		if (m.type === 'append') return console.log('append')
		if (!m.messages[0].message) return

		if (m.messages[0].message?.conversation === 'hi') {
			return sock.sendMessage(m.messages[0].key.remoteJid!, {
				text: 'hello from deno!',
			})
		}
	})
}
