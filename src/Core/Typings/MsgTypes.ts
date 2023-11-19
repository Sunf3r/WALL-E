import type { MsgTypes } from './types.js';

const textMsgs = {
	'conversation': 'text',
	'extendedTextMessage': 'text',
	'editedMessage': 'text',
};

const mediaMsgs = {
	'imageMessage': 'image',
	'stickerMessage': 'sticker',
	'videoMessage': 'video',
	'contactMessage': 'contact',
	'documentMessage': 'document',
	'audioMessage': 'audio',
};

const coolMsgTypes = {
	...textMsgs,
	...mediaMsgs,
	'locationMessage': 'location',
};

const msgTypes = {
	...textMsgs,
	...mediaMsgs,
	'protocolMessage': 'protocol',
	'reactionMessage': 'reaction',
	'locationMessage': 'location',
};

const visualMsgs = {
	'imageMessage': 'image',
	'stickerMessage': 'sticker',
	'videoMessage': 'video',
};

const isMedia = (type: MsgTypes) => Object.values(visualMsgs).includes(type);

export { coolMsgTypes, isMedia, mediaMsgs, msgTypes, textMsgs, visualMsgs };
