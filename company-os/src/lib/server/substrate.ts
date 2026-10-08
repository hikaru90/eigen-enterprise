/**
 * Substrate checks for P0 Arrival (first-conversation.md): fail fast, say
 * exactly what is broken, offer the fix command. Never fake readiness.
 * Code reports facts; the LLM only phrases them.
 */

import type { Sql } from './db.ts';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProbeResult = {
	ok: boolean;
	detail?: string;
	fix?: string;
}

export type Probe = {
	name: string;
	run(): Promise<ProbeResult>;
}

export type SubstrateCheck = {
	name: string;
	ok: boolean;
	detail?: string;
	fix?: string;
}

export type SubstrateReport = {
	ok: boolean;
	checks: SubstrateCheck[];
}

export async function runSubstrateChecks(probes: Probe[]): Promise<SubstrateReport> {
	const checks: SubstrateCheck[] = [];
	for (const probe of probes) {
		try {
			const result = await probe.run();
			checks.push({ name: probe.name, ok: result.ok, detail: result.detail, fix: result.fix });
		} catch (cause) {
			checks.push({
				name: probe.name,
				ok: false,
				detail: (cause as Error).message,
				fix: 'investigate the error above'
			});
		}
	}
	return { ok: checks.every((c) => c.ok), checks };
}

/** Postgres reachable and answering. */
export function postgresProbe(sql: Sql): Probe {
	return {
		name: 'postgres',
		async run() {
			await sql`select 1`;
			return { ok: true, detail: 'connected' };
		}
	};
}

/** Migrations directory matches what has been applied. */
export function migrationsProbe(sql: Sql, migrationsDir: string): Probe {
	return {
		name: 'migrations',
		async run() {
			const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
			const appliedRows = await sql`select name from schema_migrations`;
			const applied = new Set(appliedRows.map((r) => r.name as string));
			const pending = files.filter((f) => !applied.has(f));
			if (pending.length > 0) {
				return {
					ok: false,
					detail: `pending migrations: ${pending.join(', ')}`,
					fix: 'run the migration runner (company-os: npm run migrate)'
				};
			}
			return { ok: true, detail: `${applied.size} applied` };
		}
	};
}

/** Git available — modules are git repos (architecture §7.1). */
export function gitProbe(): Probe {
	return {
		name: 'git',
		async run() {
			const { stdout } = await execFileAsync('git', ['--version']);
			return { ok: true, detail: stdout.trim() };
		}
	};
}
