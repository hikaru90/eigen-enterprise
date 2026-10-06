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
import {
	FIRST_CONVERSATION_SYSTEM_PROMPT,
	firstConversationTools
} from './first-conversation.ts';
import type { FirstConversationContext } from './first-conversation.ts';

export interface ConversationDeps {
	client: LlmClient;
	sessions: SessionStore;
	memory: MemoryStore;
	/** P0 runs these fresh at session open — production passes real probes. */
	substrateProbes?: Probe[];
	maxSteps?: number;
}

const SESSION_START_MARKER = '(session opened — begin the first conversation)';

export interface OpenedSession {
	sessionId: string;
	report: SubstrateReport;
	events: LoopEvent[];
}

/** P0 — create the session, run the substrate check, let the agent arrive. */
export async function openSession(deps: ConversationDeps): Promise<OpenedSession> {
	const session = await deps.sessions.create();
	const report = await runSubstrateChecks(deps.substrateProbes ?? []);

	const prefix: ChatMessage[] = [
		{ role: 'system', content: FIRST_CONVERSATION_SYSTEM_PROMPT },
		{ role: 'system', content: `SUBSTRATE REPORT (code-generated, authoritative):\n${JSON.stringify(report, null, 2)}` },
		{ role: 'user', content: SESSION_START_MARKER }
	];
	await deps.sessions.append(session.id, prefix);

	const events = await runTurnLoop(deps, session.id, prefix);
	return { sessionId: session.id, report, events };
}

/** One founder exchange: persist their message, run the loop, persist the output. */
export async function runTurn(
	deps: ConversationDeps,
	sessionId: string,
	userText: string
): Promise<LoopEvent[]> {
	const session = await deps.sessions.get(sessionId);
	if (!session) throw new Error(`Session ${sessionId} does not exist.`);
	const userMessage: ChatMessage = { role: 'user', content: userText };
	await deps.sessions.append(sessionId, [userMessage]);
	return runTurnLoop(deps, sessionId, [userMessage]);
}

async function runTurnLoop(
	deps: ConversationDeps,
	sessionId: string,
	additions: ChatMessage[]
): Promise<LoopEvent[]> {
	const session = await deps.sessions.get(sessionId);
	if (!session) throw new Error(`Session ${sessionId} does not exist.`);

	const registry = new ToolRegistry<FirstConversationContext>();
	for (const def of firstConversationTools()) registry.register(def);

	const before = session.messages.length;
	const events: LoopEvent[] = [];
	for await (const event of runLoop({
		client: deps.client,
		registry,
		ctx: { memory: deps.memory },
		messages: [...session.messages, ...additions],
		maxSteps: deps.maxSteps
	})) {
		events.push(event);
	}

	const finish = events.at(-1);
	if (finish?.type === 'finish') {
		const generated = finish.messages.slice(before + additions.length);
		if (generated.length > 0) await deps.sessions.append(sessionId, generated);
	}
	return events;
}
