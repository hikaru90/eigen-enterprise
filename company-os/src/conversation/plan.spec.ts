import { describe, expect, it } from 'vitest';
import { processState, processStateMessage, QUESTION_PLAN } from './plan.ts';
import { InMemoryMemoryStore } from '../memory.ts';
import type { MemoryStore } from '../memory.ts';

async function storeWith(resolved: string[]): Promise<MemoryStore> {
	const memory = new InMemoryMemoryStore();
	for (const key of resolved) {
		await memory.remember({ kind: 'answer', key, value: 'v', source: 'founder' });
	}
	return memory;
}

describe('processState — the code-owned agenda', () => {
	it('an empty company starts at question 1', async () => {
		const state = await processState(await storeWith([]));
		expect(state.phase).toBe('interrogation');
		expect(state.next).toEqual({ key: 'company.name', skippable: false });
		expect(state.resolved).toEqual([]);
	});

	it('walks the plan in order — answers and skips both resolve a slot', async () => {
		const memory = new InMemoryMemoryStore();
		await memory.remember({ kind: 'answer', key: 'company.name', value: 'Hafenlicht' });
		await memory.remember({ kind: 'skip', key: 'company.audience', value: '(skipped)' });
		const state = await processState(memory);
		expect(state.next).toEqual({ key: 'company.cta', skippable: false });
		expect(state.resolved).toEqual(['company.name', 'company.audience']);
	});

	it('language is only demanded after every core question is resolved', async () => {
		const coreKeys = QUESTION_PLAN.filter((q) => !q.conditional).map((q) => q.key);
		const state = await processState(await storeWith(coreKeys));
		expect(state.phase).toBe('language_check');
		expect(state.next).toEqual({ key: 'site.language', skippable: false });
	});

	it('everything resolved means ready to render — no next question exists', async () => {
		const all = QUESTION_PLAN.map((q) => q.key);
		const state = await processState(await storeWith(all));
		expect(state.phase).toBe('ready_to_render');
		expect(state.next).toBeNull();
	});

	it('latest-wins re-answers do not duplicate resolved slots', async () => {
		const memory = new InMemoryMemoryStore();
		await memory.remember({ kind: 'answer', key: 'company.name', value: 'a' });
		await memory.remember({ kind: 'answer', key: 'company.name', value: 'b' });
		const state = await processState(memory);
		expect(state.resolved).toEqual(['company.name']);
		expect(state.next).toEqual({ key: 'company.audience', skippable: false });
	});
});

describe('processStateMessage — the injected agenda', () => {
	it('demands the next question by key', async () => {
		const message = processStateMessage(await processState(await storeWith([])));
		expect(message).toContain('PROCESS STATE');
		expect(message).toContain('"company.name"');
		expect(message).toContain('ask_question');
	});

	it('the render phase forbids questions', async () => {
		const all = QUESTION_PLAN.map((q) => q.key);
		const message = processStateMessage(await processState(await storeWith(all)));
		expect(message).toContain('Do NOT ask any question');
	});
});
