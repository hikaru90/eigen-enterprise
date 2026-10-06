import { describe, expect, it } from 'vitest';
import { openSession, runTurn } from './turn.ts';
import type { ConversationDeps } from './turn.ts';
import { InMemoryMemoryStore } from '../memory.ts';
import { InMemorySessionStore } from '../session.ts';
import { FakeClient, finishStop, finishToolCalls, text, toolCall } from '../testing.ts';
import type { StreamEvent } from '../llm.ts';
import { resumeContext } from '../resume.ts';

function depsWith(
	turns: StreamEvent[][],
	overrides: Partial<ConversationDeps> = {}
): { deps: ConversationDeps; sessions: InMemorySessionStore; memory: InMemoryMemoryStore } {
	const sessions = new InMemorySessionStore();
	const memory = new InMemoryMemoryStore();
	return {
		deps: {
			client: new FakeClient(turns) as unknown as ConversationDeps['client'],
			sessions,
			memory,
			substrateProbes: [
				{ name: 'postgres', run: () => Promise.resolve({ ok: true, detail: 'connected' }) },
				{ name: 'git', run: () => Promise.resolve({ ok: true, detail: 'git version 2.47' }) }
			],
			...overrides
		},
		sessions,
		memory
	};
}

const greetAndAsk = (question: string): StreamEvent[] => [
	text('Your OS is running. '),
	toolCall('q1', 'ask_question', { question }),
	finishToolCalls
];

describe('openSession (P0)', () => {
	it('reports a healthy substrate in the transcript and ends the turn with question 1', async () => {
		const { deps, sessions } = depsWith([greetAndAsk('What is your company called, and what do you do in one sentence?')]);
		const { sessionId, report, events } = await openSession(deps);

		expect(report.ok).toBe(true);
		expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'awaiting_user' });

		const session = await sessions.get(sessionId);
		const roles = session!.messages.map((m) => m.role);
		expect(roles).toEqual(['system', 'system', 'user', 'assistant', 'tool']);
		expect(session!.messages[1]!.content).toContain('SUBSTRATE REPORT');
		expect(session!.messages[1]!.content).toContain('"ok": true');

		// the ask_question call is on the transcript with its tool result
		const assistant = session!.messages[3]!;
		expect(assistant.tool_calls?.[0]?.function.name).toBe('ask_question');
		const toolResult = JSON.parse(session!.messages[4]!.content!);
		expect(toolResult.turn_ends).toBe(true);
	});

	it('a failing probe lands in the transcript as an honest failure — no faked readiness', async () => {
		const { deps, sessions } = depsWith([
			[text('Postgres is down. Run: docker compose up -d db'), finishStop]
		], {
			substrateProbes: [
				{
					name: 'postgres',
					run: () =>
						Promise.resolve({
							ok: false,
							detail: 'connection refused',
							fix: 'docker compose up -d db'
						})
				}
			]
		});
		const { report, events } = await openSession(deps);
		expect(report.ok).toBe(false);
		// scripted model states the failure (text only) — the loop completes the turn normally
		expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed' });
		void sessions;
	});
});

describe('runTurn (P1 interrogation)', () => {
	it('saves the founder answer to memory and asks exactly one next question', async () => {
		const { deps, sessions, memory } = depsWith([
			greetAndAsk('What is your company called?'),
			[
				text('Noted. '),
				toolCall('s1', 'save_answer', { key: 'company.name', value: 'Hafenlicht Studio' }),
				toolCall('q2', 'ask_question', { question: 'Who is it for?' }),
				finishToolCalls
			]
		]);
		const opened = await openSession(deps);
		const events = await runTurn(deps, opened.sessionId, 'Hafenlicht Studio — Hochzeitsfotografie in Hamburg');

		// memory has the answer, verbatim value, founder source
		const latest = await memory.latest();
		expect(latest).toEqual([
			expect.objectContaining({ kind: 'answer', key: 'company.name', value: 'Hafenlicht Studio', source: 'founder' })
		]);

		// the turn ends awaiting the founder
		expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'awaiting_user' });

		// everything persisted: user message + assistant + both tool results
		const session = await sessions.get(opened.sessionId);
		const tail = session!.messages.slice(-4);
		expect(tail[0]).toMatchObject({ role: 'user', content: 'Hafenlicht Studio — Hochzeitsfotografie in Hamburg' });
		expect(tail[1]!.tool_calls?.map((c) => c.function.name)).toEqual(['save_answer', 'ask_question']);
		expect(tail[2]!.role).toBe('tool');
		expect(tail[3]!.role).toBe('tool');
	});

	it('resume works mid-interrogation — nothing is lost, ever', async () => {
		const { deps } = depsWith([
			greetAndAsk('What is your company called?'),
			[
				toolCall('s1', 'save_answer', { key: 'company.name', value: 'Hafenlicht' }),
				toolCall('q2', 'ask_question', { question: 'Who is it for?' }),
				finishToolCalls
			]
		]);
		const opened = await openSession(deps);
		await runTurn(deps, opened.sessionId, 'Hafenlicht');

		// a "fresh process" resolves the same stores and resumes
		const session = await deps.sessions.get(opened.sessionId);
		expect(session).not.toBeNull();
		const resume = await resumeContext(deps.sessions, deps.memory);
		expect(resume?.session.id).toBe(opened.sessionId);
		expect(resume?.companyName).toBe('Hafenlicht');
	});

	it('a second tool call after the halting one is NOT executed — and the transcript stays valid', async () => {
		const { deps, sessions } = depsWith([
			greetAndAsk('What is your company called?'),
			[
				toolCall('q2', 'ask_question', { question: 'Who is it for?' }),
				toolCall('x2', 'save_answer', { key: 'company.audience', value: 'invented audience' }),
				finishToolCalls
			]
		]);
		const opened = await openSession(deps);
		const events = await runTurn(deps, opened.sessionId, 'Hafenlicht');

		expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'awaiting_user' });
		const session = await sessions.get(opened.sessionId);
		const skipped = session!.messages.at(-1)!;
		expect(skipped.role).toBe('tool');
		expect(skipped.content).toContain('NOT EXECUTED');
		expect(skipped.content).toContain('one question per turn');
		// the skipped save must NOT have reached memory — no invented audience
		const latest = await deps.memory.latest();
		expect(latest.find((e) => e.key === 'company.audience')).toBeUndefined();
	});

});

describe('maxSteps guard in conversation', () => {
	it('a runaway turn fails loud instead of drifting', async () => {
		// ask_question halts the turn, so it can never overrun — the guard exists
		// for non-halting tools. Open normally, then loop save_answer with maxSteps 2.
		const save = (n: string, key: string): StreamEvent[] => [
			toolCall(n, 'save_answer', { key, value: 'v' }),
			finishToolCalls
		];
		const base = depsWith([greetAndAsk('What is your company called?')]);
		const opened = await openSession(base.deps);
		const runaway: ConversationDeps = {
			...base.deps,
			client: new FakeClient([
				save('a', 'company.name'),
				save('b', 'company.audience'),
				save('c', 'company.cta')
			]) as unknown as ConversationDeps['client'],
			maxSteps: 2
		};
		await expect(runTurn(runaway, opened.sessionId, 'go on')).rejects.toThrowError(/maxSteps \(2\)/);
	});
});

