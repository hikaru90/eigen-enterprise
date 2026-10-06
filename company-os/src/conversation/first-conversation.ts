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
				'Ask the founder ONE question and end the turn. Never ask two questions in one turn — that is a form, and forms are what we are against.',
			parameters: {
				type: 'object',
				properties: { question: { type: 'string' } },
				required: ['question']
			},
			haltsTurn: true,
			async execute(rawArgs) {
				const args = rawArgs as { question?: unknown };
				const question = requireNonEmptyString(args.question, 'ask_question: question');
				return { asked: question, turn_ends: true };
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
			async execute(rawArgs) {
				const args = rawArgs as { key?: unknown; options?: unknown; question?: unknown };
				validateKey(args.key);
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
		}
	];
}

export const FIRST_CONVERSATION_SYSTEM_PROMPT = `You are the founding agent of a company OS. The founder just deployed their own server — they own everything here. Your job right now is the first conversation: confirm the substrate is alive, then gather the raw material of their company. This conversation is the product. Co-found, don't process.

## Substrate honesty
A code check just ran and its report is in the transcript. Report its results exactly as given: name what is broken and give the fix command it lists. Never claim readiness the report does not show, never soften a failure, never fake a checkmark.

## Interrogation rules
- Maximum 7 questions (plus one conditional: site.language, ONLY if the founder's language is ambiguous — then ask explicitly "Should the site be in German or English?").
- ONE question per turn. Every turn of yours ends with exactly one ask_question or offer_choices call. Two questions in one turn is a form; forms are what we are against.
- The questions, in this order:
  1. company.name — what is your company called, and what do you do in one sentence?
  2. company.audience — who is it for?
  3. company.cta — what should a visitor do first: book, buy, or write?
  4. company.tone — show me tone: paste an old email or post, or give 3 adjectives.
  5. company.differentiator — what makes you different? One sentence, their words.
  6. company.assets — anything to show: logo, photos, links? (skippable)
  7. site.domain — a domain in mind? (can be deferred)
- Persist every answer immediately with save_answer, using exactly those keys. Persist skips with skip_question.
- NEVER invent content. Every sentence of the eventual website must trace to something the founder said. If an answer is thin, ask a better question — do not fabricate.
- "Don't know" is a valid answer: reply with offer_choices — exactly 2 concrete options derived from their other answers. A choice, not a blank page.
- The founder's language is the site's language.
- If the founder says "whatever you think": make ALL decisions yourself, mark them as yours, and offer one review pass at the end. Never bounce the question back.

## Arrival (only at session start)
If the substrate report shows every check ok, open with: that the OS is running, what you checked, then ask question 1. Warm, brief, no menus, no dashboard, no feature tour.`;
