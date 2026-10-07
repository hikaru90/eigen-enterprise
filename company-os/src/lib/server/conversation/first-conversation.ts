/**
 * The first conversation — P0 Arrival + P1 Interrogation (first-conversation.md).
 *
 * Division of labor: the LLM runs the interview (everything semantic); CODE
 * enforces the invariants — one question per turn (halting tools), question
 * budget, never-invent validation at the save door, honest substrate report.
 */

import type { ToolContext, ToolDef } from '../tools.ts';
import { ToolError } from '../tools.ts';
import type { MemoryStore } from '../memory.ts';
import { processState } from './plan.ts';

/** The fixed answer vocabulary — each key feeds the website module directly. */
export const CONVERSATION_KEYS = [
	'company.name',
	'company.audience',
	'company.cta',
	'company.tone',
	'company.differentiator',
	'company.assets',
	'site.domain',
	'site.language'
] as const;

export type ConversationKey = (typeof CONVERSATION_KEYS)[number];

/**
 * Distinct keys that may be answered/skipped: the doc's 7 questions plus the
 * conditional site.language check (first-conversation.md Q2.5, asked only when
 * ambiguous). The M8 eval still measures "questions asked ≤ 7".
 */
export const QUESTION_BUDGET = CONVERSATION_KEYS.length;

export interface FirstConversationContext extends ToolContext {
	memory: MemoryStore;
}

/**
 * Structural agenda enforcement, evaluated LIVE from memory: after the model
 * saved the founder's answer mid-turn, the next required question is already
 * the new one. The model cannot ask off-agenda, cannot skip ahead, cannot
 * stall on an earlier question, and cannot ask anything once the interview
 * is complete.
 */
async function enforceAgenda(
	key: ConversationKey,
	ctx: FirstConversationContext,
	tool: string
): Promise<void> {
	const live = await processState(ctx.memory);
	if (live.phase === 'ready_to_render') {
		throw new ToolError(
			`${tool}: no question is required now — the interview is complete. End the turn with plain text.`
		);
	}
	if (live.phase === 'rendered') {
		throw new ToolError(
			`${tool}: the website is rendered — the interview is over. Asking questions is no longer part of the process.`
		);
	}
	if (key !== live.next?.key) {
		throw new ToolError(
			`${tool}: the agenda requires "${live.next?.key}" next — you asked for "${key}". Deliver exactly the required question.`
		);
	}
}

async function distinctAnsweredKeys(memory: MemoryStore): Promise<Set<string>> {
	const entries = await memory.latest();
	return new Set(entries.filter((e) => e.kind === 'answer' || e.kind === 'skip').map((e) => e.key));
}

function validateKey(key: unknown): asserts key is ConversationKey {
	if (typeof key !== 'string' || !CONVERSATION_KEYS.includes(key as ConversationKey)) {
		throw new ToolError(
			`save_answer: key must be one of ${CONVERSATION_KEYS.join(', ')} — got ${JSON.stringify(key)}.`
		);
	}
}

function requireNonEmptyString(value: unknown, what: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new ToolError(
			`${what} must be a non-empty string — never invent content; if the founder did not answer, use skip_question.`
		);
	}
	return value.trim();
}

/** A fresh registry's worth of tools for the first conversation. */
export function firstConversationTools(): Array<ToolDef<FirstConversationContext>> {
	return [
		{
			name: 'save_answer',
			description:
				'Persist one founder answer to company memory. Call it immediately after receiving an answer, before asking anything else.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', enum: [...CONVERSATION_KEYS] },
					value: { type: 'string', description: 'The founder\'s own words, verbatim where possible.' }
				},
				required: ['key', 'value']
			},
			async execute(rawArgs, ctx) {
				const args = rawArgs as { key?: unknown; value?: unknown };
				validateKey(args.key);
				const value = requireNonEmptyString(args.value, 'save_answer: value');
				const asked = await distinctAnsweredKeys(ctx.memory);
				if (!asked.has(args.key) && asked.size >= QUESTION_BUDGET) {
					throw new ToolError(
						`Question budget spent (${QUESTION_BUDGET} distinct questions answered/skipped). Work with what you have — refine conversationally without new question keys.`
					);
				}
				const entry = await ctx.memory.remember({
					kind: 'answer',
					key: args.key,
					value,
					source: 'founder'
				});
				return { saved: { key: entry.key, value: entry.value } };
			}
		},
		{
			name: 'skip_question',
			description:
				'Record that the founder skipped a question (questions about assets and domain are skippable). Skipped things become visibly placeholders — never inventions.',
			parameters: {
				type: 'object',
				properties: { key: { type: 'string', enum: [...CONVERSATION_KEYS] } },
				required: ['key']
			},
			async execute(rawArgs, ctx) {
				const args = rawArgs as { key?: unknown };
				validateKey(args.key);
				const asked = await distinctAnsweredKeys(ctx.memory);
				if (!asked.has(args.key) && asked.size >= QUESTION_BUDGET) {
					throw new ToolError(`Question budget spent (${QUESTION_BUDGET} distinct questions).`);
				}
				await ctx.memory.remember({
					kind: 'skip',
					key: args.key,
					value: '(skipped by founder)',
					source: 'founder'
				});
				return { skipped: args.key };
			}
		},
		{
			name: 'ask_question',
			description:
				'Ask the founder ONE question and end the turn. The key must be the agenda\'s next key from PROCESS STATE. Never ask two questions in one turn — that is a form, and forms are what we are against.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', enum: [...CONVERSATION_KEYS] },
					question: { type: 'string' }
				},
				required: ['key', 'question']
			},
			haltsTurn: true,
			async execute(rawArgs, ctx) {
				const args = rawArgs as { key?: unknown; question?: unknown };
				validateKey(args.key);
				await enforceAgenda(args.key, ctx, 'ask_question');
				const question = requireNonEmptyString(args.question, 'ask_question: question');
				return { asked: question, key: args.key, turn_ends: true };
			}
		},
		{
			name: 'offer_choices',
			description:
				'When the founder does not know, offer exactly 2 concrete options derived from their other answers — a choice, not a blank page. Ends the turn.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', enum: [...CONVERSATION_KEYS] },
					options: {
						type: 'array',
						items: { type: 'string' },
						minItems: 2,
						maxItems: 2,
						description: 'Exactly 2 concrete options.'
					},
					question: { type: 'string' }
				},
				required: ['key', 'options', 'question']
			},
			haltsTurn: true,
			async execute(rawArgs, ctx) {
				const args = rawArgs as { key?: unknown; options?: unknown; question?: unknown };
				validateKey(args.key);
				await enforceAgenda(args.key, ctx, 'offer_choices');
				const question = requireNonEmptyString(args.question, 'offer_choices: question');
				if (
					!Array.isArray(args.options) ||
					args.options.length !== 2 ||
					!args.options.every((o) => typeof o === 'string' && o.trim().length > 0) ||
					(args.options[0] as string).trim() === (args.options[1] as string).trim()
				) {
					throw new ToolError(
						'offer_choices: options must be exactly 2 distinct non-empty strings — a choice, not a blank page.'
					);
				}
				return {
					asked: question,
					choices: args.options.map((o) => (o as string).trim()),
					turn_ends: true
				};
			}
		},
		{
			name: 'mark_not_needed',
			description:
				'Record that a conditional question does not apply (e.g. site.language is unambiguous from the conversation). Requires a reason. This is a process decision, not a founder answer.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', enum: [...CONVERSATION_KEYS] },
					reason: { type: 'string' }
				},
				required: ['key', 'reason']
			},
			async execute(rawArgs, ctx) {
				const args = rawArgs as { key?: unknown; reason?: unknown };
				validateKey(args.key);
				const reason = requireNonEmptyString(args.reason, 'mark_not_needed: reason');
				await ctx.memory.remember({ kind: 'skip', key: args.key, value: reason, source: 'agent' });
				return { marked: args.key, reason };
			}
		}
	];
}

export const FIRST_CONVERSATION_SYSTEM_PROMPT = `You are the founding agent of a company OS. The founder just deployed their own server — they own everything here. A code process drives this conversation and you are its voice: the founder never has to push you. Before every turn you receive PROCESS STATE (code-generated, authoritative). It is the agenda. You follow it.

## Your job each turn
1. If the founder's message contains an answer, persist it immediately with save_answer — their words, verbatim where possible.
2. End your turn by delivering the NEXT step from PROCESS STATE: ask_question for the required question, or offer_choices when they don't know. The question itself is delivered by the tool — keep any prose before it to one short line.
3. If PROCESS STATE says ready_to_render: no question. Tell the founder their company is saved and the interview is complete; the website build comes next. Plain text, end of turn.

## Hard rules
- NEVER invent. No company names, no taglines, no facts, no sections, no tasks beyond this process. Every sentence of the eventual website must trace to something the founder said.
- NEVER ask "what do you want to do?", "where were we?", or anything that hands the agenda back to the founder. You always know the next step — it is in PROCESS STATE.
- The substrate report (session start) is code-generated. Report failures exactly, with their fix command. Never claim readiness it does not show.
- company.assets and site.domain are skippable: if the founder waves them off, record skip_question and move on. Skipped things become visibly placeholders — never inventions.
- site.language is conditional: at the language_check step, ask it explicitly ("Should the site be in German or English?") unless the conversation language is unambiguous — then mark_not_needed with the reason.
- "Don't know" is a valid answer: offer_choices with exactly 2 concrete options derived from their other answers. A choice, not a blank page.
- The founder's language is the site's language.
- If the founder says "whatever you think": decide everything yourself, mark decisions as yours, offer one review pass at the end. Never bounce the question back.

## Arrival (session start)
If the substrate report is all green: say the OS is running and what you checked, then immediately deliver question 1 (company.name). Warm, brief, no menus, no dashboard, no feature tour. If anything failed: say exactly what is broken and give the fix command. Do not ask any question.`
