/**
 * Website copy generation — never-invent made structural (decision W5).
 *
 * Two LLM passes, both meaning work the code may not do:
 *   1. draftCopy  — drafts the site copy FROM the founder's answers only;
 *                   every section must cite the answer keys it used.
 *   2. auditCopy  — the hard filter: sentences stating prices, legal claims
 *                   or certifications the founder never gave are rejected
 *                   BEFORE commit. No string heuristics — the LLM judges
 *                   meaning, the code only parses, validates and persists.
 *
 * Both passes fail loud on unparseable or contract-violating output.
 */

import type { LlmClient, ChatMessage } from '../../src/lib/server/llm.ts';

export const CONTENT_SCHEMA = 'company-os/website@0.1';

/** The content contract, mirrored in module.json — the only section shapes the renderer accepts. */
export const SECTION_TYPES = ['hero', 'about', 'differentiator', 'offer', 'cta'] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export interface CtaAction {
	type: 'email' | 'url' | 'phone';
	/** Literally provided by the founder — the audit pass verifies this. */
	value: string;
}

export interface SiteSection {
	id: string;
	type: SectionType;
	/** Answer keys this section's copy was derived from — non-empty. */
	sources: string[];
	headline?: string;
	subline?: string;
	title?: string;
	body?: string[];
	items?: { title: string; text: string }[];
	text?: string;
	buttonLabel?: string;
	action?: CtaAction;
}

export interface SiteContent {
	schema: typeof CONTENT_SCHEMA;
	/** ISO 639-1 code — chosen by the LLM from the site.language answer (meaning work). */
	language: string;
	company: { name: string };
	sections: SiteSection[];
}

export class CopyError extends Error {}

/** Founder answers only (kind = 'answer'); skips never reach the copy pass. */
export type AnswerMap = Record<string, string>;

async function completeJson(client: LlmClient, messages: ChatMessage[], what: string): Promise<unknown> {
	let text = '';
	for await (const event of client.stream({ messages, temperature: 0.2 })) {
		if (event.type === 'text_delta') text += event.text;
	}
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) {
		throw new CopyError(`${what}: the model returned no JSON object — refusing to guess. Output was: ${text.slice(0, 300)}`);
	}
	const raw = text.slice(start, end + 1);
	try {
		return JSON.parse(raw) as unknown;
	} catch (cause) {
		throw new CopyError(`${what}: unparseable JSON from the model — ${String(cause)}. Output was: ${raw.slice(0, 300)}`);
	}
}

const DRAFT_SYSTEM = `You write the copy for a small company's first website. You are given the founder's interview answers and nothing else.

HARD RULES:
- Use ONLY facts the founder stated. Never invent names, numbers, prices, history, certifications, awards or claims. If the material for a section is thin, write less — never pad with invention.
- The site language: derive an ISO 639-1 code from the founder's language answer and use that language for ALL copy.
- Every section must list "sources": the exact answer keys (e.g. "company.name") the copy was derived from. A section without sources is invalid.
- A CTA action ({type: "email"|"url"|"phone", value}) is allowed ONLY when the founder literally provided that address/number. Otherwise omit "action" entirely.
- Write in the founder's tone. Short sentences. Handmade, not corporate.

OUTPUT: one JSON object, nothing else:
{
  "schema": "company-os/website@0.1",
  "language": "<iso-639-1>",
  "company": { "name": "<exact company name from the answers>" },
  "sections": [
    { "type": "hero",          "headline": "...", "subline": "...", "sources": [...] },
    { "type": "about",         "title": "...", "body": ["paragraph", "..."], "sources": [...] },
    { "type": "differentiator","title": "...", "body": ["paragraph", "..."], "sources": [...] },
    { "type": "offer",         "title": "...", "items": [{ "title": "...", "text": "..." }], "sources": [...] },
    { "type": "cta",           "title": "...", "text": "...", "buttonLabel": "...", "action": {...}?, "sources": [...] }
  ]
}
Omit sections whose answers give nothing to say — except "hero", which is always required.`;

function requireString(value: unknown, what: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new CopyError(`${what} must be a non-empty string — got ${JSON.stringify(value) ?? 'undefined'}.`);
	}
	return value.trim();
}

export async function draftCopy(client: LlmClient, answers: AnswerMap): Promise<SiteContent> {
	const answeredKeys = Object.keys(answers);
	if (answeredKeys.length === 0) {
		throw new CopyError('draftCopy: no founder answers to draft from — never invent.');
	}

	const parsed = (await completeJson(
		client,
		[
			{ role: 'system', content: DRAFT_SYSTEM },
			{ role: 'user', content: JSON.stringify(answers, null, 2) }
		],
		'draftCopy'
	)) as Record<string, unknown>;

	if (parsed.schema !== CONTENT_SCHEMA) {
		throw new CopyError(`draftCopy: content schema must be "${CONTENT_SCHEMA}" — got ${JSON.stringify(parsed.schema)}.`);
	}
	const language = requireString(parsed.language, 'draftCopy: language');
	if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(language)) {
		throw new CopyError(`draftCopy: language must be an ISO 639-1 code — got "${language}".`);
	}
	const company = parsed.company as { name?: unknown } | undefined;
	const name = requireString(company?.name, 'draftCopy: company.name');

	const rawSections = parsed.sections;
	if (!Array.isArray(rawSections) || rawSections.length === 0) {
		throw new CopyError('draftCopy: sections must be a non-empty array.');
	}

	const sections: SiteSection[] = rawSections.map((entry, index) => {
		const section = entry as Record<string, unknown>;
		const type = section.type;
		if (typeof type !== 'string' || !SECTION_TYPES.includes(type as SectionType)) {
			throw new CopyError(
				`draftCopy: section ${index} has unknown type ${JSON.stringify(type)} — allowed: ${SECTION_TYPES.join(', ')}.`
			);
		}
		const sources = section.sources;
		if (!Array.isArray(sources) || sources.length === 0) {
			throw new CopyError(`draftCopy: section "${type}" must cite its source answers — "sources" was empty.`);
		}
		for (const key of sources) {
			if (typeof key !== 'string' || !(key in answers)) {
				throw new CopyError(
					`draftCopy: section "${type}" cites "${JSON.stringify(key)}" which the founder never answered — never invent.`
				);
			}
		}
		const out: SiteSection = { id: `s${index + 1}`, type: type as SectionType, sources: sources as string[] };
		if (section.headline !== undefined) out.headline = requireString(section.headline, `draftCopy: ${type}.headline`);
		if (section.subline !== undefined) out.subline = requireString(section.subline, `draftCopy: ${type}.subline`);
		if (section.title !== undefined) out.title = requireString(section.title, `draftCopy: ${type}.title`);
		if (section.text !== undefined) out.text = requireString(section.text, `draftCopy: ${type}.text`);
		if (section.buttonLabel !== undefined) {
			out.buttonLabel = requireString(section.buttonLabel, `draftCopy: ${type}.buttonLabel`);
		}
		if (section.body !== undefined) {
			if (!Array.isArray(section.body) || section.body.length === 0) {
				throw new CopyError(`draftCopy: ${type}.body must be a non-empty array of paragraphs.`);
			}
			out.body = section.body.map((p, i) => requireString(p, `draftCopy: ${type}.body[${i}]`));
		}
		if (section.items !== undefined) {
			if (!Array.isArray(section.items) || section.items.length === 0) {
				throw new CopyError(`draftCopy: ${type}.items must be a non-empty array.`);
			}
			out.items = section.items.map((item, i) => {
				const it = item as Record<string, unknown>;
				return {
					title: requireString(it.title, `draftCopy: ${type}.items[${i}].title`),
					text: requireString(it.text, `draftCopy: ${type}.items[${i}].text`)
				};
			});
		}
		if (section.action !== undefined) {
			const action = section.action as Record<string, unknown>;
			const actionType = action.type;
			if (actionType !== 'email' && actionType !== 'url' && actionType !== 'phone') {
				throw new CopyError(`draftCopy: ${type}.action.type must be email|url|phone — got ${JSON.stringify(actionType)}.`);
			}
			out.action = { type: actionType, value: requireString(action.value, `draftCopy: ${type}.action.value`) };
		}
		if (type === 'hero' && (out.headline === undefined || out.subline === undefined)) {
			throw new CopyError('draftCopy: the hero section requires headline and subline.');
		}
		return out;
	});

	const hero = sections.find((s) => s.type === 'hero');
	if (!hero) throw new CopyError('draftCopy: the hero section is required.');

	return { schema: CONTENT_SCHEMA, language, company: { name }, sections };
}

const AUDIT_SYSTEM = `You are the never-invent auditor for website copy. You get the founder's interview answers and drafted website copy.

Find every sentence that states something the founder did NOT say. Flag especially:
- prices, fees, or monetary amounts
- legal claims, certifications, seals, awards, "certified", "official"
- concrete numbers (years, counts, percentages) not present in the answers
- named third parties, partners or clients the founder never mentioned
- promises or guarantees beyond the founder's wording

Paraphrases of what the founder said are FINE. Marketing tone is FINE. Only flag content that adds facts.

OUTPUT: one JSON object, nothing else: { "violations": [ { "section": "<type>", "sentence": "...", "reason": "..." } ] }
Empty violations array when everything traces to the answers.`;

export interface CopyViolation {
	section: string;
	sentence: string;
	reason: string;
}

/** The W5 hard filter — returns [] when clean, throws naming every offending sentence otherwise. */
export async function auditCopy(client: LlmClient, content: SiteContent, answers: AnswerMap): Promise<CopyViolation[]> {
	const parsed = (await completeJson(
		client,
		[
			{ role: 'system', content: AUDIT_SYSTEM },
			{ role: 'user', content: JSON.stringify({ answers, copy: content }, null, 2) }
		],
		'auditCopy'
	)) as { violations?: unknown };

	if (!parsed || !Array.isArray(parsed.violations)) {
		throw new CopyError('auditCopy: the model returned no violations array — refusing to guess.');
	}
	const violations: CopyViolation[] = parsed.violations.map((v, i) => {
		const entry = v as Record<string, unknown>;
		return {
			section: requireString(entry.section, `auditCopy: violations[${i}].section`),
			sentence: requireString(entry.sentence, `auditCopy: violations[${i}].sentence`),
			reason: requireString(entry.reason, `auditCopy: violations[${i}].reason`)
		};
	});
	if (violations.length > 0) {
		const detail = violations.map((v) => `— "${v.sentence}" (${v.section}): ${v.reason}`).join('\n');
		throw new CopyError(
			`auditCopy: ${violations.length} sentence(s) state things the founder never said — rejected before commit:\n${detail}`
		);
	}
	return violations;
}
