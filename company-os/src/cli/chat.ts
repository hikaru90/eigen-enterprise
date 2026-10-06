/**
 * The chat surface for the wedge slice: `npm run chat`.
 * Real substrate probes, real persistence, the agent drives — the founder
 * answers. This is the first conversation, runnable, before any web UI exists.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { connect, databaseUrlFromEnv } from '../lib/server/db.ts';
import { migrate } from '../lib/server/migrate.ts';
import { llmConfigFromEnv, LlmClient } from '../lib/server/llm.ts';
import { PgMemoryStore } from '../lib/server/memory.ts';
import { PgSessionStore } from '../lib/server/session.ts';
import { gitProbe, migrationsProbe, postgresProbe } from '../lib/server/substrate.ts';
import { resumeContext } from '../lib/server/resume.ts';
import { openSession, runTurn } from '../lib/server/conversation/turn.ts';
import type { ConversationDeps } from '../lib/server/conversation/turn.ts';
import { renderEvent } from './render.ts';
import type { LoopEvent } from '../lib/server/loop.ts';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

function render(events: LoopEvent[]): void {
	let prev: LoopEvent | null = null;
	for (const event of events) {
		for (const line of renderEvent(event, prev)) process.stdout.write(line);
		prev = event;
	}
}

async function main(): Promise<void> {
	const sql = connect(databaseUrlFromEnv());
	const ran = await migrate(sql, MIGRATIONS_DIR);
	console.log(ran.length > 0 ? `migrations applied: ${ran.join(', ')}` : 'migrations up to date');

	const deps: ConversationDeps = {
		client: new LlmClient(llmConfigFromEnv()),
		sessions: new PgSessionStore(sql),
		memory: new PgMemoryStore(sql),
		substrateProbes: [postgresProbe(sql), migrationsProbe(sql, MIGRATIONS_DIR), gitProbe()]
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

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	rl.prompt = () => process.stdout.write('> ');
	rl.prompt();
	rl.on('line', (line) => {
		const text = line.trim();
		if (text.length === 0) {
			rl.prompt();
			return;
		}
		runTurn(deps, sessionId, text)
			.then(render)
			.catch((cause: Error) => {
				console.error(`\n✗ ${cause.message}`);
				rl.prompt();
			});
	});
	rl.on('close', async () => {
		console.log('\nSaved. Your answers persist — run npm run chat again to continue.');
		await sql.end();
		process.exit(0);
	});
}

main().catch((cause: Error) => {
	console.error(`✗ ${cause.message}`);
	process.exit(1);
});
