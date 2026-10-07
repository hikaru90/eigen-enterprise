/**
 * Conversation turns: openSession (P0) and runTurn (one founder exchange).
 * Persistence is turn-level: the user message goes in before the loop runs,
 * everything the loop generates goes in after — a crash loses nothing said.
 */

import type { ChatMessage, LlmClient } from '../llm.ts';
import { runLoop } from '../loop.ts';
import type { LoopEvent } from '../loop.ts';
import { ToolRegistry } from '../tools.ts';
import type { MemoryStore } from '../memory.ts';
import type { SessionStore } from '../session.ts';
import { runSubstrateChecks } from '../substrate.ts';
import type { Probe, SubstrateReport } from '../substrate.ts';
import { renderWebsiteTool } from '../../../../modules/website/index.ts';
import type { RenderWebsiteToolDeps } from '../../../../modules/website/index.ts';
import {
	FIRST_CONVERSATION_SYSTEM_PROMPT,
	firstConversationTools
} from './first-conversation.ts';
import type { FirstConversationContext } from './first-conversation.ts';
import { processState, processStateMessage } from './plan.ts';

export interface ConversationDeps {
	client: LlmClient;
	sessions: SessionStore;
	memory: MemoryStore;
	/** P0 runs these fresh at session open — production passes real probes. */
	substrateProbes?: Probe[];
	maxSteps?: number;
	/** The website module (M3). Absent = COMPANY_OS_SITES_DIR unset —
	 * interrogation works, rendering fails loud at the moment it is due. */
	website?: RenderWebsiteToolDeps;
}

const SESSION_START_MARKER = '(session opened — begin the first conversation)';

export interface OpenedSession {
	sessionId: string;
	report: SubstrateReport;
	events: LoopEvent[];
}

/** P0 — create the session, run the substrate check, let the agent arrive. */
export async function openSession(
	deps: ConversationDeps,
	onEvent?: (event: LoopEvent) => void
): Promise<OpenedSession> {
	const session = await deps.sessions.create();
	const report = await runSubstrateChecks(deps.substrateProbes ?? []);

	const prefix: ChatMessage[] = [
		{ role: 'system', content: FIRST_CONVERSATION_SYSTEM_PROMPT },
		{ role: 'system', content: `SUBSTRATE REPORT (code-generated, authoritative):\n${JSON.stringify(report, null, 2)}` },
		{ role: 'user', content: SESSION_START_MARKER }
	];
	await deps.sessions.append(session.id, prefix);

	// A broken substrate must NOT have the process demand a question —
	// the honest failure IS the turn.
	const events = await runTurnLoop(deps, session.id, { requireQuestion: report.ok, onEvent });
	return { sessionId: session.id, report, events };
}

/** One founder exchange: persist their message, run the loop, persist the output. */
export async function runTurn(
	deps: ConversationDeps,
	sessionId: string,
	userText: string,
	onEvent?: (event: LoopEvent) => void
): Promise<LoopEvent[]> {
	const session = await deps.sessions.get(sessionId);
	if (!session) throw new Error(`Session ${sessionId} does not exist.`);
	const userMessage: ChatMessage = { role: 'user', content: userText };
	await deps.sessions.append(sessionId, [userMessage]);
	return runTurnLoop(deps, sessionId, { requireQuestion: true, onEvent });
}

async function runTurnLoop(
	deps: ConversationDeps,
	sessionId: string,
	opts: { requireQuestion?: boolean; onEvent?: (event: LoopEvent) => void } = {}
): Promise<LoopEvent[]> {
	const requireQuestion = opts.requireQuestion ?? true;
	const session = await deps.sessions.get(sessionId);
	if (!session) throw new Error(`Session ${sessionId} does not exist.`);

	const registry = new ToolRegistry<FirstConversationContext>();
	for (const def of firstConversationTools()) registry.register(def);
	if (deps.website) registry.register(renderWebsiteTool(deps.website));

	// The process state is computed fresh every turn and injected as the last
	// message. It is agenda, not suggestion — and it is never persisted
	// (recomputed from memory on every turn, so resume is always exact).
	const state = await processState(deps.memory);

	// Misconfiguration must fail before the model is invoked — a turn that
	// demands a render with no site directory can never succeed.
	if (state.phase === 'ready_to_render' && !deps.website) {
		throw new Error(
			'render_website: the website module is not wired — COMPANY_OS_SITES_DIR is not set. ' +
				'Add `COMPANY_OS_SITES_DIR=/absolute/path` to your .env and retry. The OS does not guess.'
		);
	}
	const stateMessage: ChatMessage = { role: 'system', content: processStateMessage(state) };

	const persistedLength = session.messages.length;
	let loopMessages: ChatMessage[] = [...session.messages, stateMessage];
	let correction: ChatMessage | null = null;

	for (let attempt = 1; attempt <= 2; attempt++) {
		const events: LoopEvent[] = [];
		for await (const event of runLoop({
			client: deps.client,
			registry,
			ctx: { memory: deps.memory },
			messages: loopMessages,
			maxSteps: deps.maxSteps
		})) {
			opts.onEvent?.(event);
			events.push(event);
		}

		const finish = events.at(-1);
		if (finish?.type !== 'finish') {
			throw new Error('Agent loop ended without a finish event.');
		}

		// At ready_to_render the agenda is the render_website call — a turn that
		// ends without it tried to hand the process back.
		const renderCalled = finish.messages
			.slice(persistedLength)
			.some(
				(m) =>
					m.role === 'assistant' && m.tool_calls?.some((c) => c.function.name === 'render_website')
			);
		const processSatisfied =
			finish.reason === 'awaiting_user' ||
			state.phase === 'rendered' ||
			(state.phase === 'ready_to_render' && renderCalled) ||
			(!requireQuestion && finish.reason === 'completed');
		if (processSatisfied) {
			const generated = finish.messages
				.slice(persistedLength)
				.filter((m) => m !== stateMessage && (correction === null || m !== correction));
			if (generated.length > 0) await deps.sessions.append(sessionId, generated);
			return events;
		}

		// The turn ended without delivering the next question — the model tried
		// to hand the agenda back. One bounded correction, then fail loud.
		if (!requireQuestion) {
			const generated = finish.messages
				.slice(persistedLength)
				.filter((m) => m !== stateMessage && (correction === null || m !== correction));
			if (generated.length > 0) await deps.sessions.append(sessionId, generated);
			return events;
		}
		if (attempt >= 2) {
			throw new Error(
				`Agent ended the turn without delivering the required step (${state.next?.key ?? state.phase}) twice — refusing to drift from the process.`
			);
		}
		correction = {
			role: 'user',
			content:
				state.phase === 'ready_to_render'
					? '(process) You ended your turn without calling render_website. The interview is complete — say one short line that you are building the website, then call the render_website tool with no arguments and halt. Do not ask anything else.'
					: `(process) You ended your turn without delivering the next question. The agenda requires "${state.next?.key}" now. Ask it via ask_question and halt. Do not ask anything else.`
		};
		loopMessages = [...finish.messages, correction];
	}
	throw new Error('unreachable');
}
