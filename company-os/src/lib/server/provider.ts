/**
 * LLM provider configuration — the "normal people" path (owner directive:
 * "i want to get guided through this in a ui as a user"). The key is entered
 * once in the guided setup and stored in the founder's own database.
 *
 * Resolution order: DB config (guided setup) → env (dev convenience) → null
 * (= the UI shows the setup screen). A null config is a surface, never a
 * silent fallback.
 */

import type { Sql } from './db.ts';
import { LlmClient } from './llm.ts';
import type { LlmConfig, Transport } from './llm.ts';

export interface ProviderSetup {
	baseUrl: string;
	apiKey: string;
	model: string;
}

export class PgProviderStore {
	private readonly sql: Sql;

	constructor(sql: Sql) {
		this.sql = sql;
	}

	async get(): Promise<ProviderSetup | null> {
		const rows = await this.sql<ProviderRow[]>`
			select base_url, api_key, model from provider_config where id = 1
		`;
		const row = rows[0];
		return row ? { baseUrl: row.base_url, apiKey: row.api_key, model: row.model } : null;
	}

	async save(setup: ProviderSetup): Promise<void> {
		await this.sql`
			insert into provider_config (id, base_url, api_key, model, updated_at)
			values (1, ${setup.baseUrl}, ${setup.apiKey}, ${setup.model}, now())
			on conflict (id) do update
			set base_url = excluded.base_url,
			    api_key = excluded.api_key,
			    model = excluded.model,
			    updated_at = now()
		`;
	}
}

type ProviderRow = { base_url: string; api_key: string; model: string };

/** Env-based config for dev — null when unset (never a default). */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderSetup | null {
	const baseUrl = env.COMPANY_OS_LLM_BASE_URL;
	const apiKey = env.COMPANY_OS_LLM_API_KEY;
	const model = env.COMPANY_OS_LLM_MODEL;
	if (!baseUrl || !apiKey || !model) return null;
	return { baseUrl, apiKey, model };
}

/** DB first, env second, null means "run the guided setup". */
export async function resolveLlmConfig(
	store: PgProviderStore,
	env: NodeJS.ProcessEnv = process.env
): Promise<LlmConfig | null> {
	const fromDb = await store.get();
	if (fromDb) return fromDb;
	return providerFromEnv(env);
}

/**
 * Prove the credentials work with a real request. The guided setup never
 * fakes readiness — a bad key returns the provider's exact error.
 */
export async function verifyProviderSetup(
	setup: ProviderSetup,
	transport?: Transport
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const client = new LlmClient(
			{ baseUrl: setup.baseUrl, apiKey: setup.apiKey, model: setup.model },
			transport
		);
		for await (const _ of client.stream({
			messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
			temperature: 0
		})) {
			break; // the first streamed event proves the endpoint answered
		}
		return { ok: true };
	} catch (cause) {
		return { ok: false, error: (cause as Error).message };
	}
}
