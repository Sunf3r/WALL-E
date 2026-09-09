// setup-reset - runResetStrong and DB helpers - Deno-only
// - uses Deno-filesystem for clean and DB truncate - no npm
import { existsSync } from './env.ts'
import { join } from './runners.ts'

// Manual environment loader
export function stripInlineComment(val: string): string {
	let out = ''
	let quote: string | null = null
	for (let i = 0; i < val.length; i++) {
		const c = val[i]
		if (quote) {
			out += c
			if (c === quote) quote = null
		} else if (c === "'" || c === '"') {
			quote = c
			out += c
		} else if (c === '#') {
			const prev = out[out.length - 1]
			if (prev === undefined || prev === ' ' || prev === '\t') break
			out += c
		} else {
			out += c
		}
	}
	return out.trim()
}

export function loadEnv() {
	const envPath = join('conf', '.env')

	if (existsSync(envPath)) {
		const content = Deno.readTextFileSync(envPath)

		for (const line of content.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const index = trimmed.indexOf('=')
			if (index > 0) {
				const key = trimmed.substring(0, index).trim()
				let val = stripInlineComment(trimmed.substring(index + 1).trim())
				if (
					(val.startsWith("'") && val.endsWith("'") && val.length >= 2) ||
					(val.startsWith('"') && val.endsWith('"') && val.length >= 2)
				) {
					val = val.substring(1, val.length - 1)
				}
				Deno.env.set(key, val)
			}
		}
	}
}

// 6 - Reset folders and database
export function cleanFolderContents(dirPath: string) {
	if (existsSync(dirPath)) {
		try {
			for (const { name: file } of Deno.readDirSync(dirPath)) {
				const fullPath = join(dirPath, file)
				Deno.removeSync(fullPath, { recursive: true })
			}
			console.log(`  Cleaned: ${dirPath}`)
		} catch (e: any) {
			console.error(`  Failed to clean ${dirPath}:`, e.message)
		}
	} else {
		Deno.mkdirSync(dirPath, { recursive: true })
		console.log(`  Created: ${dirPath}`)
	}
}

export function runResetLight() {
	console.log('\n--- Cleaning Temporary and Auth folders ---')
	cleanFolderContents(join('conf', 'gen', 'auth'))
	cleanFolderContents(join('conf', 'gen', 'cache'))
	cleanFolderContents(join('conf', 'gen', 'temp'))
	console.log('Light Reset completed successfully.')
}

export async function runResetStrong() {
	console.log('\n--- Database Truncation (Strong Reset) ---')
	console.log('Loading database configuration...')

	// Load the env file into Deno.env.toObject() if needed
	loadEnv()

	if (!Deno.env.toObject().DATABASE_URL) {
		console.error('Error: DATABASE_URL is not set in conf/.env. Cannot truncate database.')
		return
	}
	try {
		console.log('Loading Prisma Client...')
		// Import generated client
		const { PrismaClient } = await import('@conf/gen/prisma/client.ts')
		let prisma: any

		try {
			const { PrismaPg } = await import('@prisma/adapter-pg')
			const adapter = new PrismaPg({ connectionString: Deno.env.toObject().DATABASE_URL })
			prisma = new PrismaClient({ adapter })
		} catch (_e) {
			//@ts-ignore Fallback to standard PrismaClient
			prisma = new PrismaClient()
		}

		console.log('Connecting to database...')
		await prisma.$connect()

		console.log('Truncating key and credential tables...')
		const keyResult = await prisma.authKey.deleteMany()
			.catch((e: any) => ({ count: 0, error: e }))

		if ('error' in keyResult && keyResult.error) {
			console.warn(
				'  Warning: Could not delete authKeys:',
				keyResult.error.message || keyResult.error,
			)
		} else console.log(`  Deleted ${keyResult.count} auth keys.`)

		const credsResult = await prisma.authCreds.deleteMany()
			.catch((e: any) => ({ count: 0, error: e }))
		if ('error' in credsResult && credsResult.error) {
			console.warn(
				'  Warning: Could not delete authCreds:',
				credsResult.error.message || credsResult.error,
			)
		} else console.log(`  Deleted ${credsResult.count} credentials.`)

		await prisma.$disconnect()
		console.log('Strong Reset completed.')
	} catch (e: any) {
		console.error('Failed to execute database truncation:', e.message || e)
	}
}
