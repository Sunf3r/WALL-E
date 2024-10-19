import makeWASocket, {
	type AnyMessageContent,
	type BaileysEventMap,
	Browsers,
	downloadMediaMessage,
	fetchLatestBaileysVersion,
	GroupMetadata,
	makeCacheableSignalKeyStore,
	type proto,
	useMultiFileAuthState,
} from 'baileys';
// import RequestCode from './RequestCode';
import { Cmd, Logger, Msg, User } from '../Typings';
import { readdirSync } from 'fs'; // DENO point
import { resolve } from 'path';

export default class Bot {
	sock!: ReturnType<typeof makeWASocket>;
	wait: Map<string, Function>;
	cmds: Map<string, Cmd>;
	aliases: Map<string, string>;
	users: Map<string, User>;
	events: Map<string, Function>;
	groups: Map<string, GroupMetadata>;

	constructor(public auth: string, public logger: Logger) {
		this.logger = logger;
		this.auth = auth; // auth folder
		this.sock;
		this.wait = new Map<string, Function>();
		// arbitrary functions that can be called on events
		this.users = new Map<string, User>(); // Users map
		this.groups = new Map<string, GroupMetadata>(); // Groups map
		this.events = new Map<string, Function>(); // Events map
		this.cmds = new Map<string, Cmd>(); // Cmds map
		this.aliases = new Map<string, string>(); // Cmd aliases map
	}

	async connect() {
		const { version } = await fetchLatestBaileysVersion();
		console.log(`WhatsApp v${version.join('.')}`);
		// Fetch latest WA Web version

		const { state, saveCreds } = await useMultiFileAuthState(this.auth);
		// Use saved session

		this.sock = makeWASocket({
			auth: {
				creds: state.creds,
				// cache makes the store send/receive msgs faster
				keys: makeCacheableSignalKeyStore(state.keys, this.logger),
			},
			browser: Browsers.macOS('Desktop'),
			logger: this.logger,
			markOnlineOnConnect: false,
			// mobile: true,
			printQRInTerminal: true,
			syncFullHistory: true,
			// ignore status updates
			shouldIgnoreJid: (jid: string) => jid.includes('broadcast'),
			version,
		});

		// if (process.argv.includes('--mobile')) await RequestCode(this.sock);

		this.sock.ev.on('creds.update', saveCreds);
		// save login creds

		// Loading commands
		await this.folderHandler(`../Commands`, this.loadCommands);
		// folderHandler() reads a folder and call the function
		// for each file
		this.folderHandler(`../Events`, this.loadEvents);
		// Loading Events
	}

	async send(id: string | Msg, body: string | AnyMessageContent, reply?: proto.IWebMessageInfo) {
		// Intermediate function to send msgs easier
		const chat = typeof id === 'string' ? id : id.chat;
		const text = typeof body === 'object' ? body : { text: body };
		const quote = reply ? { quoted: reply } : typeof id === 'string' ? {} : { quoted: id?.raw };

		return await this.sock.sendMessage(chat, text, quote);
	}

	async react(m: Msg, emoji: string) { // reacts on a msg
		this.send(m.chat, { react: { text: emoji, key: m.raw.key } });
	}

	async folderHandler(path: string, handler: Function) {
		path = resolve(__dirname, path);

		for (const category of readdirSync(path)) {
			// For each category folder
			for (const file of readdirSync(`${path}/${category}`)) {
				// for each file of each category
				const imported = await import(`file:${path}/${category}/${file}`);

				// call function to this file
				await handler.bind(this)(file, category, imported);
			}
		}
	}

	async loadCommands(file: string, _category: string, imported: any) { // DENO point
		const cmd: Cmd = new imported.default.default();
		cmd.name = file.slice(0, -3);

		const properties = Object.assign({
			name: '',
			aliases: [],
			cooldown: 3,
			run: cmd.run,
		} as Cmd, cmd);
		// Compare cmd properties with a 'template base'
		// Fill missing data with default data

		// Set cmd
		this.cmds.set(properties.name!, properties);

		properties.aliases
			?.forEach((a) => this.aliases.set(a, properties.name!));
		// Set cmd aliases
	}

	async loadEvents(file: string, category: string, imported: any) {
		const event = imported.default.default;
		const name = `${category}.${file.slice(0, -3)}`;
		// folder/file names are the same of lib events
		this.events.set(name, event);

		// Listen to the event here
		this.sock.ev.on(name as keyof BaileysEventMap, (...args) => {
			// It allows to modify events in run time
			this.events.get(name)!.bind(this)(...args, name);
			// eventFunction(this, ...args);
		});
	}

	async getGroup(id: string) {
		// check group cache
		if (this.groups.has(id)) return this.groups.get(id);

		// fetch group data
		const group = await this.sock.groupMetadata(id);

		// set group data and return it
		if (group) return this.groups.set(group.id, group) && group;
	}

	async downloadMedia(msg: Msg) {
		return await downloadMediaMessage(msg.raw, 'buffer', {}, {
			logger: this.logger,
			reuploadRequest: this.sock.updateMediaMessage,
		})! as Buffer;
	}
}