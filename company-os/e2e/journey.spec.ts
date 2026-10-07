/**
 * The wedge journey, in a real browser, against the real product:
 * guided setup → the 7-question interview → the render → the reveal → the
 * founder's committed site at /site. Plus the honest-failure journeys.
 *
 * The stack is owned by `npm run co -- e2e` (run-e2e.ts). Only the LLM is
 * scripted (the mock gateway) — everything else is production build,
 * Postgres, git, HTTP and Chromium.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loadScript, resetDb, resetSitesDir, SITES_DIR, BASE_URL, MOCK_URL } from './helpers.ts';
import { wedgeJourneyScript, providerUnauthorizedScript, FOUNDER_REPLIES } from './scripts.ts';

/** Distinctive fragment of each question the scripted model asks, in order. */
const QUESTION_FRAGMENTS = [
	'Wie heißt Ihr Unternehmen',
	'Wer soll die Website erreichen',
	'Was sollen Besucher als Nächstes tun',
	'Wie soll die Website klingen',
	'Was macht Sie anders',
	'Gibt es ein Logo oder Fotos',
	'Haben Sie schon eine Domain',
	'Soll die Website auf Deutsch oder Englisch'
];

async function completeSetup(page: Page, apiKey = 'mock-key'): Promise<void> {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Your company OS' })).toBeVisible();
	// Custom provider: the base URL is typed (with a trailing slash — the
	// product must normalize it, the founder always pastes one in).
	await page.getByLabel('Provider').selectOption('Custom (OpenAI-compatible)');
	await page.getByLabel('Base URL').fill(`${MOCK_URL}/`);
	await page.getByLabel('API key').fill(apiKey);
	await page.getByLabel('Model').fill('mock-model');
	await page.getByRole('button', { name: 'Check and start' }).click();
}

async function answer(page: Page, text: string): Promise<void> {
	const input = page.locator('.composer input');
	await expect(input).toBeEnabled();
	await input.fill(text);
	await input.press('Enter');
}

async function answerAll(page: Page, replies: string[], firstQuestionIndex: number): Promise<void> {
	for (let i = 0; i < replies.length; i++) {
		await answer(page, replies[i]!);
		if (i < replies.length - 1) {
			await expect(page.locator('.thread')).toContainText(QUESTION_FRAGMENTS[firstQuestionIndex + i + 1]!);
		}
	}
}

test.describe('the wedge journey', () => {
	test('J1: setup → interview → render → reveal → the founder sees their site', async ({ page }) => {
		await resetDb();
		await loadScript(wedgeJourneyScript());

		await completeSetup(page);
		await expect(page.locator('.thread')).toContainText(QUESTION_FRAGMENTS[0]!);

		await answerAll(page, FOUNDER_REPLIES, 0);

		// the reveal, then silence
		await expect(page.locator('.thread')).toContainText('Ihre Website ist fertig: /site');
		// the render progress was named, never a bare spinner (the page shows it during the build)
		await expect(page.locator('.thread')).toContainText('Alles da — ich baue Ihre Website jetzt.');

		// the founder opens their site
		await page.goto(`${BASE_URL}/site`);
		await expect(page.getByRole('heading', { name: 'Porträts bei Tageslicht.' })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.lang)).toBe('de');
		// monogram fallback — the founder has no logo, the site is still theirs
		await expect(page.locator('.monogram')).toHaveText('H');

		// ownership: a git repo committed from the first render
		const siteDir = join(SITES_DIR!, 'hafenlicht');
		expect(existsSync(join(siteDir, '.git'))).toBe(true);
		const log = execFileSync('git', ['-C', siteDir, 'log', '--oneline'], { encoding: 'utf8' });
		expect(log).toContain('render: v0.1');
		const contentJson = execFileSync('git', ['-C', siteDir, 'show', 'HEAD:content.json'], { encoding: 'utf8' });
		expect(contentJson).toContain('"sources"');
	});

	test('J2a: a wrong key surfaces the provider\'s exact error — no faked readiness', async ({ page }) => {
		await resetDb();
		resetSitesDir();
		await loadScript(providerUnauthorizedScript());

		await completeSetup(page, 'sk-definitely-wrong');

		const error = page.locator('.setup p.error');
		await expect(error).toBeVisible();
		await expect(error).toContainText('Invalid API key provided');
		// and nothing was saved: reload still demands the setup
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Your company OS' })).toBeVisible();
	});

	test('J2b: the audit rejects invented copy — nothing is published, the founder is told', async ({ page }) => {
		await resetDb();
		resetSitesDir();
		await loadScript(
			wedgeJourneyScript({
				auditViolations: [
					{ section: 'offer', sentence: 'Nur 199 € pro Sitting.', reason: 'the founder never gave a price' }
				]
			})
		);

		await completeSetup(page);
		await expect(page.locator('.thread')).toContainText(QUESTION_FRAGMENTS[0]!);
		await answerAll(page, FOUNDER_REPLIES, 0);

		// the honest failure: named, explained, nothing shipped. (The tool-error
		// progress line is transient by design — the durable evidence is the
		// explanation, the 404, and the empty sites dir.)

		const res = await fetch(`${BASE_URL}/site`);
		expect(res.status).toBe(404);
		expect(existsSync(join(SITES_DIR!, 'hafenlicht', '.git'))).toBe(false);
	});

	test('J3: reload mid-conversation loses nothing — the founder continues where they were', async ({ page }) => {
		await resetDb();
		await loadScript(wedgeJourneyScript());

		await completeSetup(page);
		await expect(page.locator('.thread')).toContainText(QUESTION_FRAGMENTS[0]!);
		await answerAll(page, FOUNDER_REPLIES.slice(0, 3), 0);
		// the third answer's turn is still streaming — wait for the question it
		// delivers, otherwise the reload races the product mid-turn
		await expect(page.locator('.thread')).toContainText(QUESTION_FRAGMENTS[3]!);

		// the founder walks away mid-interview and comes back
		await page.reload();
		await expect(page.locator('.thread')).toContainText('You were setting up Hafenlicht');
		await expect(page.locator('.thread')).toContainText(QUESTION_FRAGMENTS[3]!); // the tone question stands

		await answerAll(page, FOUNDER_REPLIES.slice(3), 3);
		await expect(page.locator('.thread')).toContainText('Ihre Website ist fertig: /site');

		await page.goto(`${BASE_URL}/site`);
		await expect(page.getByRole('heading', { name: 'Porträts bei Tageslicht.' })).toBeVisible();
	});
});
