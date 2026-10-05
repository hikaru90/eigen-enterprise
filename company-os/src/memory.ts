/**
 * Company memory — Eigen Mesh v0 (decision W8). Every founder answer is
 * persisted immediately and never overwritten; readers get latest-per-key.
 */

import type { Sql } from './db.ts';

export type MemoryInput = {
	kind: string;
	key: string;
	value: string;
	source?: string;
}

export type MemoryEntry = {
	id: string;
	kind: string;
	key: string;
	value: string;
	source: string;
	createdAt: string;
}

export type MemoryStore = {
	remember(input: MemoryInput): Promise<MemoryEntry>;
	/** Latest entry per (kind, key), sorted by kind then key. */
	latest(): Promise<MemoryEntry[]>;
	/** Full append-only history for one (kind, key), oldest first. */
	history(kind: string, key: string): Promise<MemoryEntry[]>;
}

export class InMemoryMemoryStore implements MemoryStore {
	private readonly rows: MemoryEntry[] = [];

	async remember(input: MemoryInput): Promise<MemoryEntry> {
		const entry: MemoryEntry = {
			id: crypto.randomUUID(),
			kind: input.kind,
			key: input.key,
			value: input.value,
			source: input.source ?? 'conversation',
			createdAt: new Date().toISOString()
		};
		this.rows.push(entry);
		return { ...entry };
	}

	async latest(): Promise<MemoryEntry[]> {
		const newest = new Map<string, MemoryEntry>();
		for (const row of this.rows) {
			const k = `${row.kind}\u0000${row.key}`;
			const current = newest.get(k);
			if (!current || row.createdAt >= current.createdAt) newest.set(k, row);
		}
		return [...newest.values()].sort(
			(a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key)
		);
	}

	async history(kind: string, key: string): Promise<MemoryEntry[]> {
		return this.rows
			.filter((r) => r.kind === kind && r.key === key)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			.map((r) => ({ ...r }));
	}
}

export class PgMemoryStore implements MemoryStore {
	constructor(private readonly sql: Sql) {}

	async remember(input: MemoryInput): Promise<MemoryEntry> {
		const rows = await this.sql<MemoryRow[]>`
			insert into company_memory (kind, key, value, source)
			values (${input.kind}, ${input.key}, ${input.value}, ${input.source ?? 'conversation'})
			returning id, kind, key, value, source, created_at
		`;
		return rowToEntry(rows[0]!);
	}

	async latest(): Promise<MemoryEntry[]> {
		const rows = await this.sql<MemoryRow[]>`
			select distinct on (kind, key) id, kind, key, value, source, created_at
			from company_memory
			order by kind, key, created_at desc, id desc
		`;
		return rows.map(rowToEntry);
	}

	async history(kind: string, key: string): Promise<MemoryEntry[]> {
		const rows = await this.sql<MemoryRow[]>`
			select id, kind, key, value, source, created_at
			from company_memory
			where kind = ${kind} and key = ${key}
			order by created_at asc, id asc
		`;
		return rows.map(rowToEntry);
	}
}

type MemoryRow = {
	id: string;
	kind: string;
	key: string;
	value: string;
	source: string;
	created_at: Date;
};

function rowToEntry(row: MemoryRow): MemoryEntry {
	return {
		id: row.id,
		kind: row.kind,
		key: row.key,
		value: row.value,
		source: row.source,
		createdAt: row.created_at.toISOString()
	};
}
