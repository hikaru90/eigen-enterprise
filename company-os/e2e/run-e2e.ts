/**
 * `npm run co -- e2e` — the browser journeys against the real stack.
 * This wrapper owns the stack (build + mock gateway + disposable database +
 * production server) for the lifetime of the Playwright run.
 */

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStack } from './harness.ts';
import { wedgeJourneyScript } from './scripts.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<number> {
	const stack = await startStack({ script: wedgeJourneyScript() });
	try {
		const extraArgs = process.argv.slice(2);
		// MUST be async spawn: spawnSync would block THIS process's event loop —
		// and the mock gateway lives here. A blocked loop means the gateway
		// never answers and every journey hangs at loadScript.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn('npx', ['playwright', 'test', ...extraArgs], {
				cwd: ROOT,
				stdio: 'inherit',
				env: {
					...process.env,
					E2E_BASE_URL: stack.baseUrl,
					E2E_MOCK_URL: stack.mockUrl,
					E2E_SITES_DIR: stack.sitesDir,
					E2E_DB_URL: stack.dbUrl
				}
			});
			child.on('exit', (code) => resolve(code));
		});
		return exitCode ?? 1;
	} finally {
		await stack.stop();
	}
}

main()
	.then((code) => {
		console.log(code === 0 ? '\nco e2e: PASS — the wedge journey works in a real browser.' : '\nco e2e: FAIL');
		process.exit(code);
	})
	.catch((cause: Error) => {
		console.error(`co e2e crashed: ${cause.message}`);
		process.exit(1);
	});
