import type { Cmd, CmdContext } from '../Typings';

export default abstract class Command implements Cmd {
	name?: string;
	aliases?: string[];
	cooldown?: number;
	access?: {
		dm?: boolean;
		groups?: boolean;
		onlyDevs?: boolean;
	};

	constructor(c: Cmd) {
		this.name = '';
		this.aliases = c.aliases || [];
		this.cooldown = c.cooldown || 3;
		this.access = Object.assign({
			dm: true,
			groups: true,
			onlyDevs: false,
		}, c.access);
		// Compara as permissões do comando
	}

	abstract run(ctx: CmdContext): Promise<any>;
}
