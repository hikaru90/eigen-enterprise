/**
 * The question plan — code owns the process, the LLM is only its voice.
 * The owner's directive after the first live run: "i can't push the ai to do
 * the thinking for me, it has to proactively guide me through a process."
 * The process state below is computed from memory and injected into every
 * turn; the model may not skip ahead, stall, or invent its own agenda.
 */

import type { MemoryStore } from '../memory.ts';
import type { ConversationKey } from './first-conversation.ts';

export interface PlanQuestion {
	key: ConversationKey;
	skippable: boolean;
	/** Asked only at the language_check step (site.language — only if ambiguous). */
	conditional?: boolean;
}

export const QUESTION_PLAN: PlanQuestion[] = [
	{ key: 'company.name', skippable: false },
	{ key: 'company.audience', skippable: false },
	{ key: 'company.cta', skippable: false },
	{ key: 'company.tone', skippable: false },
	{ key: 'company.differentiator', skippable: false },
	{ key: 'company.assets', skippable: true },
	{ key: 'site.domain', skippable: true },
	{ key: 'site.language', skippable: false, conditional: true }
];

export type ProcessPhase = 'interrogation' | 'language_check' | 'ready_to_render';

export interface ProcessState {
	phase: ProcessPhase;
	resolved: string[];
	next: { key: ConversationKey; skippable: boolean } | null;
}

/** Compute where the process stands from company memory alone. */
export async function processState(memory: MemoryStore): Promise<ProcessState> {
	const entries = await memory.latest();
	const resolved = entries
		.filter((e) => e.kind === 'answer' || e.kind === 'skip')
		.map((e) => e.key);

	const core = QUESTION_PLAN.filter((q) => !q.conditional);
	const nextCore = core.find((q) => !resolved.includes(q.key));
	if (nextCore) {
		return {
			phase: 'interrogation',
			resolved,
			next: { key: nextCore.key, skippable: nextCore.skippable }
		};
	}

	const language = QUESTION_PLAN.find((q) => q.key === 'site.language')!;
	if (!resolved.includes(language.key)) {
		return { phase: 'language_check', resolved, next: { key: language.key, skippable: false } };
	}

	return { phase: 'ready_to_render', resolved, next: null };
}

/** The per-turn system message: the process speaks first, in JSON. */
export function processStateMessage(state: ProcessState): string {
	const instruction =
		state.phase === 'ready_to_render'
			? 'All questions are resolved. Tell the founder their company is saved and the interview is complete — the website build comes next. Do NOT ask any question. End the turn with plain text only.'
			: `The next required question is "${state.next!.key}" (skippable: ${state.next!.skippable}). You MUST end your turn with exactly one ask_question (or offer_choices) for "${state.next!.key}" — phrase it in the founder's language, warmly, one question only. Keep prose before the tool brief; the question itself is delivered by the tool.`;
	return `PROCESS STATE (code-generated, authoritative — this is the agenda, not a suggestion):\n${JSON.stringify(
		{ phase: state.phase, resolved: state.resolved, next: state.next },
		null,
		2
	)}\n\n${instruction}`;
}
