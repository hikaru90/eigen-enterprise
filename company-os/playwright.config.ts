import { defineConfig } from '@playwright/test';

/**
 * The company-os browser journeys. The stack is NOT managed here —
 * `npm run co -- e2e` (e2e/run-e2e.ts) owns build, database, mock gateway
 * and server, then runs Playwright. Bare `npx playwright test` only works
 * while a stack is up (see e2e/README.md).
 */
export default defineConfig({
	testDir: './e2e',
	testMatch: 'journey.spec.ts',
	// One founder, one conversation, one scripted gateway — the journeys share
	// the stack serially and deliberately.
	workers: 1,
	fullyParallel: false,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: 'list',
	use: {
		baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5178',
		// Headed by default — the founder should be able to watch the product
		// walk. E2E_HEADLESS=1 for autonomous runs.
		headless: process.env.E2E_HEADLESS === '1',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	}
});
