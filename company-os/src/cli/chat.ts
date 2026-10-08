/**
 * The chat surface for the wedge slice: `npm run chat`.
 * Real substrate probes, real persistence, the agent drives — the founder
 * answers. This is the first conversation, runnable, before any web UI exists.
 */

import type { ConversationDeps } from '../lib/server/conversation/turn.ts';
import type { LoopEvent } from '../lib/server/loop.ts';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openSession, runTurn } from '../lib/server/conversation/turn.ts';
import { connect, databaseUrlFromEnv } from '../lib/server/db.ts';
import { loadDotEnv } from '../lib/server/dotenv.ts';
import { LlmClient } from '../lib/server/llm.ts';
import { PgMemoryStore } from '../lib/server/memory.ts';
import { migrate } from '../lib/server/migrate.ts';
import { PgProviderStore, resolveLlmConfig } from '../lib/server/provider.ts';
import { resumeContext } from '../lib/server/resume.ts';
import { PgSessionStore } from '../lib/server/session.ts';
import { sitesDirFromEnv } from '../lib/server/site-store.ts';
import { gitProbe, migrationsProbe, postgresProbe } from '../lib/server/substrate.ts';
import { renderEvent } from './render.ts';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

function render(events: LoopEvent[]): void {
	let prev: LoopEvent | null = null;
	for (const event of events) {
		for (const line of renderEvent(event, prev)) process.stdout.write(line);
		prev = event;
	}
}

async function main(): Promise<void> {
	// The CLI runs outside vite — bring .env in read-only (real env wins).
	loadDotEnv();
	const sql = connect(databaseUrlFromEnv());
	const ran = await migrate(sql, MIGRATIONS_DIR);
	console.log(ran.length > 0 ? `migrations applied: ${ran.join(', ')}` : 'migrations up to date');

	// Credentials resolve the same way the browser does: the founder's stored
	// config first (the guided setup wrote it into THEIR database), env second.
	// No env duplication required for the terminal path.
	const provider = new PgProviderStore(sql);
	const config = await resolveLlmConfig(provider, process.env);
	if (!config) {
		throw new Error(
			'No LLM credentials: start the app (npm run dev), complete the guided setup once — ' +
				'the key is stored in your database — or set COMPANY_OS_LLM_* in the environment.'
		);
	}
	const client = new LlmClient(config);
	const deps: ConversationDeps = {
		client,
		sessions: new PgSessionStore(sql),
		memory: new PgMemoryStore(sql),
		substrateProbes: [postgresProbe(sql), migrationsProbe(sql, MIGRATIONS_DIR), gitProbe()],
		// The website module rides the same client; the sites dir resolves at
		// render time — required, fail loud (the OS does not guess).
		website: { client, getSitesDir: () => sitesDirFromEnv(process.env) }
	};

	const resume = await resumeContext(deps.sessions, deps.memory);
	let sessionId: string;
	if (resume) {
		sessionId = resume.session.id;
		const name = resume.companyName ? resume.companyName : 'your company';
		console.log(`\nYou were setting up ${name} — where were we?\n`);
	} else {
		const opened = await openSession(deps);
		sessionId = opened.sessionId;
		render(opened.events);
	}

	let renderPrinted = false;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	rl.prompt = () => process.stdout.write('> ');
	rl.prompt();

	async function handleLine(text: string): Promise<void> {
		try {
			const events = await runTurn(deps, sessionId, text);
			render(events);
			const renderEntry = (await deps.memory.latest()).find((e) => e.kind === 'render' && e.key === 'website');
			if (renderEntry && !renderPrinted) {
				renderPrinted = true;
				const sitesDir = sitesDirFromEnv(process.env);
				console.log(`\n  Your website lives in ${sitesDir} — every version committed.`);
				console.log('  Start the app (npm run dev) and open /site to see it.');
			}
		} catch (cause) {
			console.error(`\n✗ ${(cause as Error).message}`);
		}
		rl.prompt();
	}

	// Turns run strictly in order — piped input arrives faster than turns
	// complete, and close must wait for the last turn, not kill it.
	let tail: Promise<void> = Promise.resolve();
	rl.on('line', (line) => {
		const text = line.trim();
		if (text.length === 0) return;
		tail = tail.then(() => handleLine(text));
	});
	rl.on('close', async () => {
		await tail;
		console.log('\nSaved. Your answers persist — run npm run chat again to continue.');
		await sql.end();
		process.exit(0);
	});
}

main().catch((cause: Error) => {
	console.error(`✗ ${cause.message}`);
	process.exit(1);
});
