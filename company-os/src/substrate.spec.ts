import { describe, expect, it } from 'vitest';
import { runSubstrateChecks } from './substrate.ts';
import type { Probe, ProbeResult } from './substrate.ts';

const probe = (name: string, result: ProbeResult): Probe => ({
	name,
	run: () => Promise.resolve(result)
});

describe('runSubstrateChecks', () => {
	it('reports ok when every check passes, with details', async () => {
		const report = await runSubstrateChecks([
			probe('postgres', { ok: true, detail: 'connected' }),
			probe('git', { ok: true, detail: 'git version 2.47' })
		]);
		expect(report.ok).toBe(true);
		expect(report.checks.map((c) => c.name)).toEqual(['postgres', 'git']);
	});

	it('fails the whole report when any check fails — and keeps the fix command', async () => {
		const report = await runSubstrateChecks([
			probe('postgres', { ok: true, detail: 'connected' }),
			probe('migrations', { ok: false, detail: 'pending: 0002_x.sql', fix: 'run migrate' })
		]);
		expect(report.ok).toBe(false);
		const failed = report.checks.find((c) => !c.ok);
		expect(failed?.fix).toBe('run migrate');
	});

	it('turns a throwing probe into an honest failed check, not a crash', async () => {
		const report = await runSubstrateChecks([
			{
				name: 'exploding',
				run: () => Promise.reject(new Error('connection refused'))
			}
		]);
		expect(report.ok).toBe(false);
		expect(report.checks[0]).toMatchObject({ ok: false, detail: 'connection refused' });
	});

	it('an empty probe list is vacuously ok — callers decide what must be probed', async () => {
		const report = await runSubstrateChecks([]);
		expect(report.ok).toBe(true);
		expect(report.checks).toEqual([]);
	});
});
