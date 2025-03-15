import type { Client, Message } from 'wa'

interface CmdCtx {
	msg: Message
	bot: Client
	args: str[]
}
