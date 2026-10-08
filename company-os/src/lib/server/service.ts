/**
 * The founder surface service: builds runtime deps, bootstraps or resumes the
 * session, and maps persisted messages to UI transcript entries.
 */

import type { ConversationDeps } from './conversation/turn.ts';
import type { Sql } from './db.ts';
import type { LlmConfig } from './llm.ts';
import type { ChatMessage } from './llm.ts';
import type { ProviderSetup } from './provider.ts';
import { openSession, runTurn } from './conversation/turn.ts';
import { connect, databaseUrlFromEnv } from './db.ts';
import { LlmClient } from './llm.ts';
import { PgMemoryStore } from './memory.ts';
import { migrate } from './migrate.ts';
import { PgProviderStore, resolveLlmConfig, verifyProviderSetup } from './provider.ts';
import { resumeContext } from './resume.ts';
import { PgSessionStore } from './session.ts';
import { sitesDirFromEnv } from './site-store.ts';
import { gitProbe, migrationsProbe, postgresProbe } from './substrate.ts';

export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

import path from 'node:path';

export type Runtime = {
	sql: Sql;
	deps: ConversationDeps;
	provider: PgProviderStore;
}

/** One connection + stores per process (pools are lazy); the config resolves fresh per call. */
type RuntimeCore = {
	sql: Sql;
	provider: PgProviderStore;
	buildDeps(config: LlmConfig): ConversationDeps;
}

let cachedCore: RuntimeCore | null = null;

async function core(env: NodeJS.ProcessEnv): Promise<RuntimeCore> {
	if (cachedCore) return cachedCore;
	const sql = connect(databaseUrlFromEnv(env));
	await migrate(sql, MIGRATIONS_DIR);
	const provider = new PgProviderStore(sql);
	const sessions = new PgSessionStore(sql);
	const memory = new PgMemoryStore(sql);
	cachedCore = {
		sql,
		provider,
		buildDeps: (config: LlmConfig) => {
			const client = new LlmClient(config);
			return {
				client,
				sessions,
				memory,
				substrateProbes: [postgresProbe(sql), migrationsProbe(sql, MIGRATIONS_DIR), gitProbe()],
				// The website module shares the conversation client; the sites dir
				// resolves at render time — required, fail loud (W3 convention).
				website: { client, getSitesDir: () => sitesDirFromEnv(env) }
			};
		}
	};
	return cachedCore;
}

/** Stores only — for the guided-setup route, which must work BEFORE any provider exists. */
export async function coreStores(env: NodeJS.ProcessEnv): Promise<{ sql: Sql; provider: PgProviderStore }> {
	const c = await core(env);
	return { sql: c.sql, provider: c.provider };
}

/** Build runtime deps; `null` config means the guided setup must run first. */
export async function buildRuntime(env: NodeJS.ProcessEnv): Promise<Runtime | null> {
	const c = await core(env);
	const config = await resolveLlmConfig(c.provider, env);
	if (!config) return null;
	return { sql: c.sql, provider: c.provider, deps: c.buildDeps(config) };
}

export { verifyProviderSetup };
export type { ProviderSetup };

/** A founder-visible transcript entry. */
export type UiMessage = {
	role: 'agent' | 'founder';
	text: string;
	kind: 'text' | 'question' | 'choices';
}

const SESSION_START_MARKER = '(session opened — begin the first conversation)';

/** Map persisted messages to what the founder sees. Tool saves are progress, not conversation. */
export function transcriptFromMessages(messages: ChatMessage[]): UiMessage[] {
	const out: UiMessage[] = [];
	for (const message of messages) {
		if (message.role === 'system') continue;
		if (message.role === 'user') {
			if (message.content && message.content !== SESSION_START_MARKER) {
				out.push({ role: 'founder', text: message.content, kind: 'text' });
			}
			continue;
		}
		if (message.role === 'assistant' && message.content) {
			out.push({ role: 'agent', text: message.content, kind: 'text' });
			continue;
		}
		if (message.role === 'tool' && message.content) {
			try {
				const parsed = JSON.parse(message.content) as { asked?: string; choices?: string[] };
				if (parsed.asked) {
					const text =
						parsed.choices && parsed.choices.length === 2
							? `${parsed.asked}\n1) ${parsed.choices[0]}\n2) ${parsed.choices[1]}`
							: parsed.asked;
					out.push({
						role: 'agent',
						text,
						kind: parsed.choices ? 'choices' : 'question'
					});
				}
			} catch {
				// non-conversation tool result (saves, skips) — progress, not transcript
			}
		}
	}
	return out;
}

export type SessionBootstrap = {
	sessionId: string;
	transcript: UiMessage[];
	companyName: string | null;
}

/** Resume the open session, or open a new one (P0 arrival runs server-side). */
export async function ensureSession(deps: ConversationDeps): Promise<SessionBootstrap> {
	const resume = await resumeContext(deps.sessions, deps.memory);
	if (resume) {
		const session = await deps.sessions.get(resume.session.id);
		const transcript = session ? transcriptFromMessages(session.messages) : [];
		return { sessionId: resume.session.id, transcript, companyName: resume.companyName };
	}
	const opened = await openSession(deps);
	const session = await deps.sessions.get(opened.sessionId);
	return {
		sessionId: opened.sessionId,
		transcript: session ? transcriptFromMessages(session.messages) : [],
		companyName: null
	};
}

export { runTurn };
