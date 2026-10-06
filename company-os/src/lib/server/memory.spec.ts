import { describe, expect, it } from 'vitest';
import { InMemoryMemoryStore } from './memory.ts';

describe('InMemoryMemoryStore', () => {
	it('remembers and returns latest per (kind, key), latest-wins', async () => {
		const store = new InMemoryMemoryStore();
		await store.remember({ kind: 'answer', key: 'company.name', value: 'Blaupunkt Studio' });
		await store.remember({ kind: 'answer', key: 'company.audience', value: 'photographers' });
		await store.remember({ kind: 'answer', key: 'company.name', value: 'Blaupunkt Photo Studio' });

		const latest = await store.latest();
		expect(latest).toHaveLength(2);
		expect(latest.map((e) => e.value).sort()).toEqual(['Blaupunkt Photo Studio', 'photographers']);
		expect(latest[0]!.key).toBe('company.audience'); // deterministic kind/key order
	});

	it('preserves full history oldest-first', async () => {
		const store = new InMemoryMemoryStore();
		await store.remember({ kind: 'answer', key: 'company.name', value: 'first' });
		await store.remember({ kind: 'answer', key: 'company.name', value: 'second' });

		const history = await store.history('answer', 'company.name');
		expect(history.map((e) => e.value)).toEqual(['first', 'second']);
		expect(await store.history('answer', 'nope')).toEqual([]);
	});

	it('defaults source to conversation and keeps explicit sources', async () => {
		const store = new InMemoryMemoryStore();
		const a = await store.remember({ kind: 'answer', key: 'k', value: 'v' });
		const b = await store.remember({ kind: 'decision', key: 'k', value: 'v', source: 'agent' });
		expect(a.source).toBe('conversation');
		expect(b.source).toBe('agent');
	});

	it('returns an empty list when nothing is remembered', async () => {
		expect(await new InMemoryMemoryStore().latest()).toEqual([]);
	});
});
