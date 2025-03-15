import Cmd from 'class/cmd.ts'

export default class extends Cmd {
	constructor() {
		super({
			name: 'eval',
			alias: ['e'],
			access: {
				admin: true,
			},
		})
	}

	async run() {
	}
}
