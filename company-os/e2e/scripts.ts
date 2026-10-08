/**
 * The scripted journeys — the same scripts drive the HTTP smoke test and the
 * browser journeys, so both surfaces prove the SAME conversation.
 *
 * The founder persona: Hafenlicht, a Hamburg photography studio, German.
 * Everything the mock "model" says is fixed text here — the tests assert
 * against it, so the assertions prove the plumbing, not the copy quality
 * (copy quality with a real model is the M8 eval's job).
 */

import type { ScriptEntry } from './mock-llm.ts';
import { textTurn, toolTurn } from './mock-llm.ts';

export const FOUNDER = {
	name: 'Hafenlicht — ein kleines Fotostudio aus Hamburg',
	audience: 'Familien und Selbstständige, die ehrliche Porträts wollen',
	tone: 'ruhig, warm, ungestellt',
	differentiator: 'Ich fotografiere nur bei Tageslicht, draußen oder bei Ihnen',
	assets: 'Ein Logo habe ich nicht',
	language: 'Deutsch'
} as const;

const DRAFT = {
	schema: 'company-os/website@0.1',
	language: 'de',
	company: { name: 'Hafenlicht' },
	sections: [
		{
			type: 'hero',
			headline: 'Porträts bei Tageslicht.',
			subline: 'Ehrlich, ruhig, ungestellt — aus Hamburg.',
			sources: ['company.name', 'company.differentiator']
		},
		{
			type: 'about',
			title: 'Über Hafenlicht',
			body: ['Ich fotografiere Familien und Selbstständige — bei Tageslicht, draußen oder bei Ihnen zu Hause.'],
			sources: ['company.audience', 'company.differentiator']
		},
		{
			type: 'offer',
			title: 'Was Sie bei mir bekommen',
			items: [{ title: 'Portret-Sitting', text: 'Eine Stunde bei Tageslicht, zwanzig bearbeitete Bilder.' }],
			sources: ['company.audience']
		},
		{
			type: 'cta',
			title: 'Lassen Sie uns reden',
			text: 'Schreiben Sie mir — ich antworte meist am selben Tag.',
			buttonLabel: 'E-Mail schreiben',
			action: { type: 'email', value: 'studio@hafenlicht.example' },
			sources: ['company.cta']
		}
	]
};

const q = (key: string, question: string) => ({ id: `q-${key}`, name: 'ask_question', args: { key, question } });

const save = (key: string, value: string) => ({
	id: `s-${key}-${Math.random().toString(36).slice(2, 6)}`,
	name: 'save_answer',
	args: { key, value }
});

const skip = (key: string) => ({ id: `k-${key}`, name: 'skip_question', args: { key } });

/** The full happy path: setup-verify → arrival → 7 answers → render → reveal. */
export function wedgeJourneyScript(opts: { auditViolations?: unknown[] } = {}): ScriptEntry[] {
	const violations = opts.auditViolations ?? [];
	return [
		// 0. the guided-setup verify call (any streamed response proves the endpoint)
		textTurn('ready'),
		// 1. arrival — the agent opens the conversation
		toolTurn('Willkommen! Ich bin Ihr company-os Agent.', [
			{ id: 'q1', name: 'ask_question', args: { key: 'company.name', question: 'Wie heißt Ihr Unternehmen, und was macht es — in einem Satz?' } }
		]),
		// 2..8 — one answer per turn, the agenda advances one slot each time.
		// One model response = ONE toolTurn: the save and the next question are
		// two tool calls in the same turn (distinct ids/indices).
		toolTurn('', [save('company.name', FOUNDER.name), q('company.audience', 'Wer soll die Website erreichen?')]),
		toolTurn('', [save('company.audience', FOUNDER.audience), q('company.cta', 'Was sollen Besucher als Nächstes tun?')]),
		toolTurn('', [save('company.cta', 'Mir eine E-Mail schreiben an studio@hafenlicht.example'), q('company.tone', 'Wie soll die Website klingen?')]),
		toolTurn('', [save('company.tone', FOUNDER.tone), q('company.differentiator', 'Was macht Sie anders?')]),
		toolTurn('', [save('company.differentiator', FOUNDER.differentiator), q('company.assets', 'Gibt es ein Logo oder Fotos?')]),
		toolTurn('', [skip('company.assets'), q('site.domain', 'Haben Sie schon eine Domain im Kopf?')]),
		toolTurn('', [skip('site.domain'), q('site.language', 'Soll die Website auf Deutsch oder Englisch sein?')]),
		// 9. the last answer completes the interview — the same turn starts the render
		toolTurn('Alles da — ich baue Ihre Website jetzt.', [
			save('site.language', FOUNDER.language),
			{ id: 'render', name: 'render_website', args: {} }
		]),
		// 10. inside the tool: the draft (answers only, provenance attached)
		textTurn(JSON.stringify(DRAFT)),
		// 11. inside the tool: the W5 audit
		textTurn(JSON.stringify({ violations })),
		// 12. after the tool result: the reveal, then silence
		textTurn(
			violations.length === 0
				? 'Ihre Website ist fertig: /site — sehen Sie sich das Ergebnis an. Was fällt Ihnen dazu ein?'
				: 'Beim Prüfen der Texte habe ich Sätze gefunden, die Sie nie gesagt haben. Ich habe nichts veröffentlicht. Ergänzen Sie die fehlenden Angaben, dann baue ich erneut.'
		)
	];
}

/** The provider setup answers 401 — the founder's exact error must surface. */
export function providerUnauthorizedScript(): ScriptEntry[] {
	return [{ httpError: { status: 401, body: { error: { message: 'Invalid API key provided', type: 'invalid_request_error' } } } }];
}

/** The site language answer in German, as the journey's founder replies. */
export const FOUNDER_REPLIES: string[] = [
	FOUNDER.name,
	FOUNDER.audience,
	'Mir eine E-Mail schreiben an studio@hafenlicht.example',
	FOUNDER.tone,
	FOUNDER.differentiator,
	FOUNDER.assets,
	'Habe ich noch nicht',
	FOUNDER.language
];

/**
 * The RESUME journey: the founder walked away after question 1 (a leftover
 * open session with only company.name answered) and comes back in the
 * terminal. No verify (credentials are already stored), no arrival — the
 * agenda continues at company.audience.
 */
export function wedgeResumeScript(opts: { auditViolations?: unknown[] } = {}): ScriptEntry[] {
	return wedgeJourneyScript(opts).slice(3);
}

/** Founder replies for the resume journey (everything after the name answer). */
export const FOUNDER_REPLIES_RESUME: string[] = FOUNDER_REPLIES.slice(1);
