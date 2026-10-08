import type { StreamEvent } from '../llm.ts';
import type { ConversationDeps } from './turn.ts';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryMemoryStore } from '../memory.ts';
import { resumeContext } from '../resume.ts';
import { InMemorySessionStore } from '../session.ts';
import { FakeClient, finishStop, finishToolCalls, text, toolCall } from '../testing.ts';
import { QUESTION_PLAN } from './plan.ts';
import { openSession, runTurn } from './turn.ts';

function depsWith(
	turns: StreamEvent[][],
	overrides: Partial<ConversationDeps> = {}
): {
	deps: ConversationDeps;
	sessions: InMemorySessionStore;
	memory: InMemoryMemoryStore;
	client: FakeClient;
} {
	const sessions = new InMemorySessionStore();
	const memory = new InMemoryMemoryStore();
	const client = new FakeClient(turns);
	return {
		deps: {
			client: client as unknown as ConversationDeps['client'],
			sessions,
			memory,
			substrateProbes: [
				{ name: 'postgres', run: () => Promise.resolve({ ok: true, detail: 'connected' }) },
				{ name: 'git', run: () => Promise.resolve({ ok: true, detail: 'git version 2.47' }) }
			],
			...overrides
		},
		sessions,
		memory,
		client
	};
}

const greetAndAsk = (question: string): StreamEvent[] => [
	text('Your OS is running. '),
	toolCall('q1', 'ask_question', { key: 'company.name', question }),
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
				toolCall('q2', 'ask_question', { key: 'company.audience', question: 'Who is it for?' }),
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
				toolCall('q2', 'ask_question', { key: 'company.audience', question: 'Who is it for?' }),
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
				toolCall('q2', 'ask_question', { key: 'company.audience', question: 'Who is it for?' }),
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

describe('the process drives — drift enforcement', () => {
	it('a model that ends its turn without the next question gets corrected once, then delivers', async () => {
		const { deps, client } = depsWith([
			greetAndAsk('What is your company called?'),
			[text('Great, thanks!'), finishStop], // drift: no question, hands agenda back
			[toolCall('q1b', 'ask_question', { key: 'company.name', question: 'What is your company called?' }), finishToolCalls]
		]);
		const opened = await openSession(deps);
		const events = await runTurn(deps, opened.sessionId, 'hello there');

		expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'awaiting_user' });
		// the correction reached the model on attempt 2
		const attempt2Input = client.calls.at(-1)!.messages;
		expect(attempt2Input.some((m) => m.content?.includes('You ended your turn without delivering the next question'))).toBe(true);
		expect(attempt2Input.some((m) => m.content?.includes('"company.name"'))).toBe(true);
	});

	it('a model that drifts twice fails loud — no silent agenda loss', async () => {
		const drift: StreamEvent[] = [text('Great, thanks!'), finishStop];
		const { deps } = depsWith([
			greetAndAsk('What is your company called?'),
			drift,
			drift
		]);
		const opened = await openSession(deps);
		await expect(runTurn(deps, opened.sessionId, 'hello')).rejects.toThrowError(/refusing to drift/);
	});

	it('every turn carries the code-generated PROCESS STATE as its agenda', async () => {
		const { deps, client } = depsWith([
			greetAndAsk('What is your company called?'),
			[toolCall('s1', 'save_answer', { key: 'company.name', value: 'Hafenlicht' }),
			 toolCall('q2', 'ask_question', { key: 'company.audience', question: 'Who is it for?' }),
			 finishToolCalls]
		]);
		const opened = await openSession(deps);
		await runTurn(deps, opened.sessionId, 'Hafenlicht');

		const lastCall = client.calls.at(-1)!;
		const stateMessage = lastCall.messages.at(-1)!.content ?? '';
		expect(stateMessage).toContain('PROCESS STATE');
		// agenda is turn-start state: company.name still required (the save happens mid-turn),
		// and the live re-check after the save is what lets the model deliver audience
		expect(stateMessage).toContain('"company.name"');
		// the state message is agenda, never persisted (needle unique to processStateMessage —
		// the policy prompt legitimately mentions "PROCESS STATE" too)
		const session = await deps.sessions.get(opened.sessionId);
		expect(session!.messages.some((m) => m.content?.includes('The next required question is'))).toBe(false);
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


describe('P2 — the render turn (website module)', () => {
	const DRAFT = {
		schema: 'company-os/website@0.1',
		language: 'de',
		company: { name: 'Hafenlicht' },
		sections: [
			{ type: 'hero', headline: 'Licht für den Hafen', subline: 'Aus Hamburg', sources: ['company.name'] }
		]
	};

	/** Seeding the answers after openSession IS the resume semantic: memory is the substrate. */
	async function completeInterview(memory: InMemoryMemoryStore): Promise<void> {
		for (const q of QUESTION_PLAN) {
			await memory.remember({ kind: 'answer', key: q.key, value: q.key === 'company.name' ? 'Hafenlicht' : 'v' });
		}
	}

	function siteDeps(client: unknown, dir: string): NonNullable<ConversationDeps['website']> {
		return { client: client as NonNullable<ConversationDeps['website']>['client'], getSitesDir: () => dir };
	}

	it('render_website is called at ready_to_render, drafts+audits via the LLM, commits, and records the render', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'co-render-'));
		const { deps, memory, client } = depsWith([
			greetAndAsk('What is your company called?'),
			// the render turn: one line, then the tool
			[text('Ich baue Ihre Website.'), toolCall('r1', 'render_website', {}), finishToolCalls],
			// inside the tool: draft, then audit
			[text(JSON.stringify(DRAFT)), finishStop],
			[text(JSON.stringify({ violations: [] })), finishStop],
			// the reveal, then silence
			[text('Ihre Website liegt unter /site — sehen Sie sich das Ergebnis an.'), finishStop]
		]);
		deps.website = siteDeps(client, dir);
		const opened = await openSession(deps);
		await completeInterview(memory);
		const events = await runTurn(deps, opened.sessionId, 'Fertig.');

		expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed' });
		const toolResults = events.filter((e) => e.type === 'tool_result');
		expect(
			toolResults.some((e) => e.type === 'tool_result' && !e.isError && e.call.function.name === 'render_website')
		).toBe(true);
		// the render is memory — the phase derived from it is 'rendered'
		const renderEntry = (await memory.latest()).find((e) => e.kind === 'render' && e.key === 'website');
		expect(renderEntry).toBeDefined();
		// the site is committed from the first render
		expect(existsSync(join(dir, 'hafenlicht', '.git'))).toBe(true);
		expect(existsSync(join(dir, 'hafenlicht', 'index.html'))).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	it('a model that ends the ready_to_render turn without rendering gets corrected once, then renders', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'co-render-'));
		const { deps, memory, client } = depsWith([
			greetAndAsk('What is your company called?'),
			[text('Geschafft!'), finishStop], // drift: no render call
			[toolCall('r1', 'render_website', {}), finishToolCalls],
			[text(JSON.stringify(DRAFT)), finishStop],
			[text(JSON.stringify({ violations: [] })), finishStop],
			[text('Ihre Website: /site'), finishStop]
		]);
		deps.website = siteDeps(client, dir);
		const opened = await openSession(deps);
		await completeInterview(memory);
		const events = await runTurn(deps, opened.sessionId, 'Fertig.');

		expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed' });
		expect(client.calls[2]!.messages.some((m) => m.content?.includes('without calling render_website'))).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	it('a model that never renders fails loud — the reveal cannot be faked', async () => {
		const { deps, memory, client } = depsWith([
			greetAndAsk('What is your company called?'),
			[text('Geschafft!'), finishStop],
			[text('Wirklich geschafft!'), finishStop]
		]);
		deps.website = siteDeps(client, mkdtempSync(join(tmpdir(), 'co-render-')));
		const opened = await openSession(deps);
		await completeInterview(memory);
		await expect(runTurn(deps, opened.sessionId, 'Fertig.')).rejects.toThrowError(/refusing to drift/);
	});

	it('ready_to_render without the website module fails loud before the model is invoked', async () => {
		const { deps, memory, client } = depsWith([greetAndAsk('What is your company called?')]);
		const opened = await openSession(deps);
		await completeInterview(memory);
		await expect(runTurn(deps, opened.sessionId, 'Fertig.')).rejects.toThrowError(/COMPANY_OS_SITES_DIR/);
		expect(client.calls).toHaveLength(1); // only the open turn — no model call for the failed render turn
	});

	it('after the render, the founder can talk without the process demanding anything', async () => {
		const { deps, memory, client } = depsWith([
			greetAndAsk('What is your company called?'),
			[text('Schön, dass er Ihnen gefällt!'), finishStop]
		]);
		deps.website = siteDeps(client, mkdtempSync(join(tmpdir(), 'co-render-')));
		const opened = await openSession(deps);
		await completeInterview(memory);
		await memory.remember({ kind: 'render', key: 'website', value: '{"company":"Hafenlicht","version":"0.1"}' });
		const events = await runTurn(deps, opened.sessionId, 'Das finde ich gut!');
		expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed' });
		// honest post-render behavior: no question, no invented editing power
		const stateMessage = client.calls.at(-1)!.messages.at(-1)!.content ?? '';
		expect(stateMessage).toContain('cannot edit');
	});

	it('streaming: onEvent sees every event live, identical to the returned ones', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'co-render-'));
		const { deps, memory, client } = depsWith([
			greetAndAsk('What is your company called?'),
			[text('Ich baue Ihre Website.'), toolCall('r1', 'render_website', {}), finishToolCalls],
			[text(JSON.stringify(DRAFT)), finishStop],
			[text(JSON.stringify({ violations: [] })), finishStop],
			[text('Ihre Website liegt unter /site.'), finishStop]
		]);
		deps.website = siteDeps(client, dir);
		const opened = await openSession(deps);
		await completeInterview(memory);
		const live: unknown[] = [];
		const events = await runTurn(deps, opened.sessionId, 'Fertig.', (e) => live.push(e));
		expect(live).toEqual(events);
		rmSync(dir, { recursive: true, force: true });
	});
});
