/**
 * `npm run co smoke` — the product, headless, end to end, no browser.
 *
 * Real production build + real Postgres (disposable e2e database) + real git +
 * real HTTP; only the LLM is a scripted wire-compatible gateway. This drives
 * exactly what the UI drives and asserts what the founder must see:
 * setup → the 7-question interview → render progress → the reveal → the
 * committed site served at /site.
 *
 * If this passes, "nothing works when I open the page" has one place left to
 * hide: the browser itself. That is what the Playwright journeys cover.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startStack } from './harness.ts';
import { wedgeJourneyScript, FOUNDER_REPLIES } from './scripts.ts';

let failures = 0;
function check(what: string, condition: boolean, detail = ''): void {
	const mark = condition ? '✓' : '✗';
	console.log(`${mark} ${what}${detail && !condition ? ` — ${detail}` : ''}`);
	if (!condition) failures += 1;
}

interface SseEvent {
	type: string;
	[key: string]: unknown;
}

/** POST one founder turn and read the SSE stream back as loop events. */
async function turn(baseUrl: string, sessionId: string, message: string): Promise<SseEvent[]> {
	const res = await fetch(`${baseUrl}/api/turn`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId, message })
	});
	if (!res.ok || !res.body) {
		throw new Error(`turn failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
	}
	const raw = await res.text();
	return raw
		.split('\n\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => JSON.parse(line.slice('data: '.length)) as SseEvent)
		.filter((event) => event.type !== 'done');
}

async function main(): Promise<void> {
	console.log('company-os smoke — the wedge journey, headless\n');
	const stack = await startStack({ script: wedgeJourneyScript() });
	try {
		// 1. bootstrap before any provider exists → the guided setup must be demanded
		const pre = (await (await fetch(`${stack.baseUrl}/api/session`, { method: 'POST' })).json()) as {
			providerConfigured?: boolean;
		};
		check('unconfigured product demands the guided setup', pre.providerConfigured === false);

		// 2. guided provider setup — verified against the mock, stored in the founder's DB
		const provider = (await (
			await fetch(`${stack.baseUrl}/api/provider`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ baseUrl: stack.mockUrl, apiKey: 'mock-key', model: 'mock-model' })
			})
		).json()) as { ok?: boolean; error?: string };
		check('provider credentials verified and saved', provider.ok === true, provider.error ?? '');

		// 3. bootstrap again → the arrival question
		const boot = (await (await fetch(`${stack.baseUrl}/api/session`, { method: 'POST' })).json()) as {
			providerConfigured?: boolean;
			sessionId?: string;
			transcript?: { role: string; text: string }[];
		};
		check('session opened with a transcript', typeof boot.sessionId === 'string' && (boot.transcript?.length ?? 0) > 0);
		const sessionId = boot.sessionId!;
		const arrival = boot.transcript?.at(-1)?.text ?? '';
		check('the arrival asks the first question (company.name)', arrival.includes('Unternehmen'), arrival);

		// 4. the interview — one answer per turn, one question back
		const expectedKeys = [
			'company.audience',
			'company.cta',
			'company.tone',
			'company.differentiator',
			'company.assets',
			'site.domain',
			'site.language'
		];
		let revealText = '';
		for (let i = 0; i < FOUNDER_REPLIES.length; i++) {
			const events = await turn(stack.baseUrl, sessionId, FOUNDER_REPLIES[i]!);
			const finish = events.at(-1) as { type: string; reason?: string } | undefined;
			check(`turn ${i + 1} finished cleanly`, finish?.type === 'finish', JSON.stringify(finish)?.slice(0, 200));

			const toolResults = events.filter((e) => e.type === 'tool_result') as {
				call: { function: { name: string } };
				result: string;
				isError: boolean;
			}[];
			const errored = toolResults.find((t) => t.isError);
			check(`turn ${i + 1} has no tool errors`, !errored, errored?.result ?? '');

			const text = events
				.filter((e) => e.type === 'text_delta')
				.map((e) => (e as { text: string }).text)
				.join('');

			if (i < FOUNDER_REPLIES.length - 1) {
				const asked = toolResults.find((t) => t.call.function.name === 'ask_question' && !t.isError);
				const askedKey = asked ? (JSON.parse(asked.result) as { key: string }).key : null;
				check(
					`turn ${i + 1} asks the agenda's next question (${expectedKeys[i]})`,
					askedKey === expectedKeys[i],
					`got ${askedKey ?? 'nothing'}`
				);
			} else {
				// the last answer triggers the render IN THE SAME TURN, then the reveal
				const render = toolResults.find((t) => t.call.function.name === 'render_website');
				check('the render ran in the final turn', !!render && !render.isError, render?.result?.slice(0, 300));
				revealText = text;
				check('the reveal names the site', revealText.includes('/site'), revealText);
			}
		}

		// 5. the reveal is real: /site serves the committed artifact
		const siteRes = await fetch(`${stack.baseUrl}/site`);
		const siteHtml = await siteRes.text();
		check('/site serves the rendered site', siteRes.ok, `HTTP ${siteRes.status} ${siteHtml.slice(0, 200)}`);
		check('the site carries the drafted headline', siteHtml.includes('Porträts bei Tageslicht.'));
		check('the site is in the founder\'s language', siteHtml.includes('<html lang="de">'));
		check('the site shows the monogram, not a broken logo', siteHtml.includes('>H<') || siteHtml.includes('monogram'));

		// 6. the founder owns a git repo — committed from version 0.1
		const siteDir = join(stack.sitesDir, 'hafenlicht');
		const repoExists = existsSync(join(siteDir, '.git'));
		check('the site repo exists in the sites dir', repoExists);
		if (repoExists) {
			const log = execFileSync('git', ['-C', siteDir, 'log', '--oneline'], { encoding: 'utf8' });
			check('version 0.1 is committed', log.includes('render: v0.1'), log);
			check(
				'content.json with provenance is committed',
				execFileSync('git', ['-C', siteDir, 'show', 'HEAD:content.json'], { encoding: 'utf8' }).includes('"sources"')
			);
			check(
				'the tree is clean after the render',
				execFileSync('git', ['-C', siteDir, 'status', '--porcelain'], { encoding: 'utf8' }) === ''
			);
		}

		console.log(
			failures === 0
				? `\nSMOKE PASS — the wedge journey works headless (${stack.gateway.requests.length} scripted model calls).`
				: `\nSMOKE FAIL — ${failures} check(s) failed. The product is NOT ready.`
		);
		process.exitCode = failures === 0 ? 0 : 1;
	} finally {
		await stack.stop();
	}
}

main().catch((cause: Error) => {
	console.error(`\nsmoke crashed: ${cause.message}`);
	process.exitCode = 1;
});
