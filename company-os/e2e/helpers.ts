/**
 * Test-side helpers for the browser journeys. The stack itself is owned by
 * `run-e2e.ts` (one process, one stack); tests reach the mock gateway over
 * HTTP control routes and the database directly. No shared in-memory state —
 * every hop is the same HTTP/SQL the product uses.
 */

import { rmSync } from 'node:fs';
import { loadDotEnv, devDatabaseUrl, e2eDatabaseUrl } from './harness.ts';
import postgres from 'postgres';
import type { ScriptEntry } from './mock-llm.ts';

loadDotEnv();

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5178';
export const MOCK_URL = process.env.E2E_MOCK_URL ?? 'http://127.0.0.1:5177/v1';
export const SITES_DIR = process.env.E2E_SITES_DIR;

if (!SITES_DIR) {
	console.error('e2e: E2E_SITES_DIR is not set — run the journeys via `npm run co -- e2e` (it owns the stack).');
	process.exit(1);
}

/** Reprogram the mock gateway for the next journey. */
export async function loadScript(turns: ScriptEntry[]): Promise<void> {
	const scriptUrl = `${MOCK_URL.replace(/\/v1$/, '')}/__script`;
	const res = await fetch(scriptUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ turns })
	});
	if (!res.ok) throw new Error(`loadScript failed: HTTP ${res.status} ${await res.text()}`);
}

/** Wipe founder state (provider, sessions, memory) — the next journey starts from zero. */
export async function resetDb(): Promise<void> {
	const sql = postgres(e2eDatabaseUrl(devDatabaseUrl()), { max: 1 });
	try {
		await sql`truncate agent_messages, agent_sessions, company_memory, provider_config`;
	} finally {
		await sql.end();
	}
}

/** Wipe generated sites — journeys must not see each other's renders. */
export function resetSitesDir(): void {
	if (SITES_DIR) rmSync(SITES_DIR, { recursive: true, force: true });
}
