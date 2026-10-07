import { describe, expect, it } from 'vitest';
import {
	CONVERSATION_KEYS,
	QUESTION_BUDGET,
	firstConversationTools
} from './first-conversation.ts';
import type { FirstConversationContext } from './first-conversation.ts';
import { InMemoryMemoryStore } from '../memory.ts';
import { ToolError } from '../tools.ts';

function ctxWith(seeded: Array<{ kind: string; key: string; value: string }>): {
	ctx: FirstConversationContext;
	memory: InMemoryMemoryStore;
} {
	const memory = new InMemoryMemoryStore();
	for (const s of seeded) void memory.remember({ ...s, source: 'founder' });
	return { ctx: { memory }, memory };
}

const tools = Object.fromEntries(firstConversationTools().map((t) => [t.name, t]));

describe('first conversation tools', () => {
	it('exposes exactly the conversation vocabulary', () => {
		expect(Object.keys(tools).sort()).toEqual([
			'ask_question',
			'mark_not_needed',
			'offer_choices',
			'save_answer',
			'skip_question'
		]);
		expect(CONVERSATION_KEYS).toContain('company.name');
		expect(QUESTION_BUDGET).toBe(8); // 7 questions + conditional site.language (Q2.5)
	});

	it('ask_question and offer_choices halt the turn — one question per turn is structural', () => {
		expect(tools['ask_question']!.haltsTurn).toBe(true);
		expect(tools['offer_choices']!.haltsTurn).toBe(true);
		expect(tools['save_answer']!.haltsTurn).toBeUndefined();
	});

	it('save_answer persists to memory with the founder source', async () => {
		const { ctx, memory } = ctxWith([]);
		const result = (await tools['save_answer']!.execute(
			{ key: 'company.name', value: '  Hafenlicht Studio  ' },
			ctx
		)) as { saved: { key: string; value: string } };
		expect(result.saved).toEqual({ key: 'company.name', value: 'Hafenlicht Studio' });
		const latest = await memory.latest();
		expect(latest).toEqual([
			{ kind: 'answer', key: 'company.name', value: 'Hafenlicht Studio', source: 'founder', id: latest[0]!.id, createdAt: latest[0]!.createdAt }
		]);
	});

	it('save_answer rejects unknown keys and empty values — the never-invent door', async () => {
		const { ctx } = ctxWith([]);
		await expect(
			tools['save_answer']!.execute({ key: 'made.up.key', value: 'x' }, ctx)
		).rejects.toThrowError(/key must be one of/);
		await expect(
			tools['save_answer']!.execute({ key: 'company.name', value: '   ' }, ctx)
		).rejects.toThrowError(/never invent/);
	});

	it('enforces the question budget on distinct keys — re-answers stay allowed', async () => {
		// memory is vocabulary-agnostic: seed 8 distinct keys, the next NEW key is over budget
		const junk = Array.from({ length: QUESTION_BUDGET }, (_, i) => ({
			kind: 'answer',
			key: `seeded.${i}`,
			value: 'v'
		}));
		const { ctx } = ctxWith(junk);
		await expect(
			tools['save_answer']!.execute({ key: 'company.name', value: 'Hafenlicht' }, ctx)
		).rejects.toThrowError(/Question budget spent/);
		await expect(
			tools['skip_question']!.execute({ key: 'site.domain' }, ctx)
		).rejects.toThrowError(/Question budget spent/);

		// but a re-answer of an already-answered key is always allowed
		const reanswer = ctxWith([{ kind: 'answer', key: 'company.name', value: 'old name' }]);
		await expect(
			tools['save_answer']!.execute({ key: 'company.name', value: 'new name' }, reanswer.ctx)
		).resolves.toBeTruthy();
	});

	it('skip_question records the skip', async () => {
		const { ctx, memory } = ctxWith([]);
		await tools['skip_question']!.execute({ key: 'site.domain' }, ctx);
		const latest = await memory.latest();
		expect(latest[0]).toMatchObject({ kind: 'skip', key: 'site.domain' });
	});

	it('mark_not_needed records a process decision with the agent as source', async () => {
		const { ctx, memory } = ctxWith([]);
		await tools['mark_not_needed']!.execute(
			{ key: 'site.language', reason: 'conversation is entirely German' },
			ctx
		);
		const latest = await memory.latest();
		expect(latest[0]).toMatchObject({
			kind: 'skip',
			key: 'site.language',
			source: 'agent',
			value: 'conversation is entirely German'
		});
	});

	it('offer_choices demands exactly 2 distinct non-empty options', async () => {
		// seed the agenda up to company.cta so enforcement lets this key through
		const { ctx } = ctxWith([
			{ kind: 'answer', key: 'company.name', value: 'v' },
			{ kind: 'answer', key: 'company.audience', value: 'v' }
		]);
		await expect(
			tools['offer_choices']!.execute(
				{ key: 'company.cta', options: ['only one'], question: 'q' },
				ctx
			)
		).rejects.toThrowError(/exactly 2 distinct/);
		await expect(
			tools['offer_choices']!.execute(
				{ key: 'company.cta', options: ['same', 'same'], question: 'q' },
				ctx
			)
		).rejects.toThrowError(/exactly 2 distinct/);
		const ok = (await tools['offer_choices']!.execute(
			{ key: 'company.cta', options: ['book a shoot', 'order prints'], question: 'What should visitors do first?' },
			ctx
		)) as { choices: string[]; turn_ends: boolean };
		expect(ok.choices).toEqual(['book a shoot', 'order prints']);
		expect(ok.turn_ends).toBe(true);
	});

	it('questions are impossible once the interview is done — both post-interview phases refuse loudly', async () => {
		const seeds = [
			'company.name',
			'company.audience',
			'company.cta',
			'company.tone',
			'company.differentiator',
			'company.assets',
			'site.domain',
			'site.language'
		].map((key) => ({ kind: 'answer', key, value: 'v' }));

		// ready_to_render: build the site instead of asking anything
		const readyCtx = ctxWith(seeds).ctx;
		await expect(
			tools['ask_question']!.execute({ key: 'company.name', question: 'q' }, readyCtx)
		).rejects.toThrowError(/the interview is complete/);

		// rendered: the interview is over for good
		const rendered = ctxWith([...seeds, { kind: 'render', key: 'website', value: '{"company":"x"}' }]);
		await expect(
			tools['ask_question']!.execute({ key: 'company.name', question: 'q' }, rendered.ctx)
		).rejects.toThrowError(/the interview is over/);
	});
});
