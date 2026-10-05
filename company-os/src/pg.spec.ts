import type { Sql } from './db.ts';
import type { ChatMessage } from './llm.ts';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrlFromEnv } from './db.ts';
import { PgMemoryStore } from './memory.ts';
import { migrate } from './migrate.ts';
import { resumeContext } from './resume.ts';
import { PgSessionStore } from './session.ts';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations');

describe('databaseUrlFromEnv', () => {
	it('fails loud naming the variable', () => {
		expect(() => databaseUrlFromEnv({})).toThrowError(/COMPANY_OS_DATABASE_URL/);
	});
});

// Postgres-backed suites run only against an explicit test database.
// (CI/dev: COMPANY_OS_TEST_DATABASE_URL=postgres://…/company_os_test)
const testUrl = process.env.COMPANY_OS_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('Postgres stores', () => {
	let sql: Sql;

	beforeAll(async () => {
		sql = connect(testUrl!);
	});

	afterAll(async () => {
		await sql.end();
	});

	async function clean(): Promise<void> {
		await sql`truncate agent_messages, agent_sessions, company_memory`;
	}

	it('applies migrations once and is idempotent', async () => {
		// Hermetic via tracking reset, NOT drop: this cluster preloads Apache AGE,
		// whose hook breaks DROP TABLE in any database without ag_catalog.
		await sql`truncate agent_messages, agent_sessions, company_memory`;
		await sql`delete from schema_migrations`;
		const first = await migrate(sql, MIGRATIONS_DIR);
		expect(first).toContain('0001_init.sql');
		const second = await migrate(sql, MIGRATIONS_DIR);
		expect(second).toEqual([]);
	});

	it('PgSessionStore round-trips messages in order, including tool calls', async () => {
		await clean();
		await migrate(sql, MIGRATIONS_DIR);
		const store = new PgSessionStore(sql);
		const session = await store.create();

		const assistantToolCall: ChatMessage = {
			role: 'assistant',
			content: 'Saving that.',
			tool_calls: [
				{ id: 'call_1', type: 'function', function: { name: 'save_answer', arguments: '{"key":"x"}' } }
			]
		};
		await store.append(session.id, [{ role: 'user', content: 'remember x' }, assistantToolCall]);
		await store.append(session.id, [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }]);

		const loaded = await store.get(session.id);
		expect(loaded?.messages).toEqual([
			{ role: 'user', content: 'remember x' },
			assistantToolCall,
			{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }
		]);
		expect(loaded?.status).toBe('open');
	});

	it('PgSessionStore: unknown session throws on append; missing get is null', async () => {
		await clean();
		const store = new PgSessionStore(sql);
		const missing = '00000000-0000-0000-0000-000000000001';
		expect(await store.get(missing)).toBeNull();
		await expect(store.append(missing, [{ role: 'user', content: 'x' }])).rejects.toThrowError(
			/does not exist/
		);
	});

	it('PgSessionStore: latestOpen and markCompleted', async () => {
		await clean();
		const store = new PgSessionStore(sql);
		const first = await store.create();
		await store.append(first.id, [{ role: 'user', content: 'first' }]);
		const second = await store.create();
		await store.append(second.id, [{ role: 'user', content: 'second' }]);

		expect((await store.latestOpen())?.id).toBe(second.id);
		await store.markCompleted(second.id);
		expect((await store.latestOpen())?.id).toBe(first.id);
		await expect(store.markCompleted(missing_id())).rejects.toThrowError(/does not exist/);
	});

	it('PgMemoryStore: append-only with latest-wins and full history', async () => {
		await clean();
		const store = new PgMemoryStore(sql);
		await store.remember({ kind: 'answer', key: 'company.name', value: 'erst' });
		await store.remember({ kind: 'answer', key: 'company.tone', value: 'warm, direkt' });
		await store.remember({ kind: 'answer', key: 'company.name', value: 'Hafenlicht Studio' });

		const latest = await store.latest();
		expect(latest).toHaveLength(2);
		const name = latest.find((e) => e.key === 'company.name');
		expect(name?.value).toBe('Hafenlicht Studio');

		const history = await store.history('answer', 'company.name');
		expect(history.map((e) => e.value)).toEqual(['erst', 'Hafenlicht Studio']);
	});

	it('resumeContext works over Postgres stores', async () => {
		await clean();
		const sessions = new PgSessionStore(sql);
		const memory = new PgMemoryStore(sql);
		const session = await sessions.create();
		await sessions.append(session.id, [{ role: 'user', content: 'Firma: Hafenlicht' }]);
		await memory.remember({ kind: 'answer', key: 'company.name', value: 'Hafenlicht' });

		const ctx = await resumeContext(sessions, memory);
		expect(ctx?.session.id).toBe(session.id);
		expect(ctx?.companyName).toBe('Hafenlicht');
	});
});

function missing_id(): string {
	return '00000000-0000-0000-0000-000000000002';
}
