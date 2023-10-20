import { GroupMetadata, proto } from 'baileys';
import { PrismaClient } from '@prisma/client';
import User from '../Classes/User.js';
import { TFunction } from 'i18next';
import Bot from '../Classes/Bot.js';
import { pino } from 'pino';

export type Lang = 'py' | 'lua' | 'deno' | 'node' | 'eval' | 'cpp';

export type Logger = pino.Logger<{ timestamp: () => str } & pino.ChildLoggerOptions>;

export type MsgTypes =
	| 'text'
	| 'image'
	| 'sticker'
	| 'video'
	| 'contact'
	| 'document'
	| 'audio'
	| 'protocol'
	| 'reaction'
	| 'location';

export interface Msg {
	id: str;
	chat: str;
	text: str;
	type: MsgTypes;
	isMedia: bool;
	raw: proto.IWebMessageInfo;
	quoted: Msg;
}

export interface Cmd {
	name?: str;
	aliases?: str[];
	cooldown?: num;
	access?: {
		dm?: bool;
		groups?: bool;
		onlyDevs?: bool;
	};
	react?: bool;
	run?: Function;
}

export interface CmdContext {
	prisma: PrismaClient;
	msg: Msg;
	user: User;
	group: GroupMetadata;
	bot: Bot;
	args: str[];
	cmd: Cmd;
	callCmd: str;
	t: TFunction<'translation', undefined>;
	sendUsage(): Promise<void>;
}
