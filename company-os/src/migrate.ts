/**
 * Minimal migration runner: applies pending .sql files from a directory in
 * filename order, once each, tracked in schema_migrations. Deterministic and
 * loud — a file that fails aborts mid-transaction and names itself.
 */

import type { Sql } from './db.ts';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function migrate(sql: Sql, dir: string): Promise<string[]> {
	await sql`create table if not exists schema_migrations (
		name text primary key,
		applied_at timestamptz not null default now()
	)`;

	const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
	const appliedRows = await sql`select name from schema_migrations`;
	const applied = new Set(appliedRows.map((r) => r.name as string));

	const ran: string[] = [];
	for (const file of files) {
		if (applied.has(file)) continue;
		const statements = await readFile(path.join(dir, file), 'utf8');
		await sql.begin(async (tx) => {
			await tx.unsafe(statements);
			await tx`insert into schema_migrations (name) values (${file})`;
		});
		ran.push(file);
	}
	return ran;
}
