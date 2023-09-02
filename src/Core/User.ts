import { LANG, PREFIX } from '../config.json';
import prisma from './Prisma';

export default class User {
	_userLanguage: string;
	_userPrefix: string;

	constructor(public id: string, userLanguage?: string, userPrefix?: string) {
		this.id = id;
		this.id = id;
		this._userLanguage = userLanguage || LANG;
		this._userPrefix = userPrefix || PREFIX;

		this.checkData();
	}
	public get lang() {
		return this._userLanguage;
	}

	public set lang(value: string) {
		this._userLanguage = value;

		(async () =>
			await prisma.users.upsert({
				create: {
					id: this.id,
					lang: value,
					prefix: this._userPrefix,
				},
				update: {
					lang: value,
				},
				where: { id: this.id },
			}))();
	}

	get prefix() {
		return this._userPrefix;
	}

	set prefix(value: string) {
		this._userPrefix = value;

		(async () =>
			prisma.users.upsert({
				create: {
					id: this.id,
					lang: this._userLanguage,
					prefix: value,
				},
				update: {
					prefix: value,
				},
				where: { id: this.id },
			}))();
	}

	async checkData() {
		let data = await prisma.users.findUnique({ where: { id: this.id } });

		if (!data) {
			data = await prisma.users.create({
				data: {
					id: this.id,
					lang: this._userLanguage,
					prefix: this._userPrefix,
				},
			});
		}

		this._userLanguage = data.lang;
		this._userPrefix = data.prefix;
	}
}