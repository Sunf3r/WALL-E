import type { CmdCtx } from '../map.js'

export default abstract class Cmd {
	name: str
	alias: str[]
	subCmds: str[]
	cooldown: num
	access: Partial<{
		dm: bool // cmd can run on DM
		groups: bool // cmd can run on groups
		admin: bool // only admins can run the cmd
		restrict: bool // only devs can run the cmd
	}>

	constructor(c: Partial<Cmd>) {
		this.name = ''
		this.alias = c.alias || []
		this.cooldown = c.cooldown === 0 ? 0 : c.cooldown || 3 // Ignore some cmds cooldown
		this.subCmds = c.subCmds || []
		this.access = Object.assign({
			dm: true,
			groups: true,
			admin: false,
			restrict: false,
		}, c.access) // Compare command permissions
		// with this default setting
	}

	abstract run(ctx: CmdCtx): Promise<any> // run function
}
