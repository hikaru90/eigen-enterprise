/**
 * `npm run co <command>` — one CLI to interact with and verify the tool.
 *
 *   doctor   is everything in place for the product to run? (exact fixes printed)
 *   chat     the founder conversation in your terminal (needs LLM env or setup via UI)
 *   smoke    the wedge journey end-to-end against a production build (scripted LLM)
 *   e2e      the same journey in a real browser (Playwright)
 *
 * Exit code 0 = proven, 1 = something is broken, with the reason named.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] ?? '';

async function main(): Promise<number> {
	switch (command) {
		case 'doctor':
			return doctor();
		case 'chat':
			return run('node', ['--experimental-strip-types', 'src/cli/chat.ts'], 'chat');
		case 'smoke':
			return run('node', ['--experimental-strip-types', 'e2e/smoke.ts'], 'smoke');
		case 'e2e':
			return run('npx', ['playwright', 'test'], 'e2e');
		case '':
			console.log('usage: npm run co -- <doctor|chat|smoke|e2e>');
			return 1;
		default:
			console.error(`co: unknown command "${command}" — try doctor | chat | smoke | e2e`);
			return 1;
	}
}

function run(cmd: string, args: string[], label: string): number {
	const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
	const code = result.status ?? 1;
	console.log(code === 0 ? `\nco ${label}: PASS` : `\nco ${label}: FAIL (exit ${code})`);
	return code;
}

/* ------------------------------ doctor ------------------------------ */

interface CheckResult {
	name: string;
	ok: boolean;
	detail?: string;
	fix?: string;
}

async function doctor(): Promise<number> {
	console.log('company-os doctor — what the product needs, checked in order\n');
	loadEnvFile();

	const results: CheckResult[] = [];

	// node version
	const major = Number.parseInt(process.versions.node.split('.')[0]!, 10);
	results.push({
		name: `node >= 22 (running ${process.versions.node})`,
		ok: major >= 22,
		fix: 'Install Node 22 or newer.'
	});

	// env vars
	const url = process.env.COMPANY_OS_DATABASE_URL;
	results.push({
		name: 'COMPANY_OS_DATABASE_URL is set',
		ok: !!url,
		fix: 'Add `COMPANY_OS_DATABASE_URL=postgres://user:pass@host:5432/company_os` to company-os/.env.'
	});
	results.push({
		name: 'COMPANY_OS_SITES_DIR is set (where generated websites are committed)',
		ok: !!process.env.COMPANY_OS_SITES_DIR,
		fix: 'Add `COMPANY_OS_SITES_DIR=/absolute/path` to company-os/.env.'
	});
	const llmReady =
		!!process.env.COMPANY_OS_LLM_BASE_URL && !!process.env.COMPANY_OS_LLM_API_KEY && !!process.env.COMPANY_OS_LLM_MODEL;
	results.push({
		name: 'COMPANY_OS_LLM_BASE_URL / _API_KEY / _MODEL are set (terminal chat path)',
		ok: llmReady,
		detail: llmReady ? undefined : 'The browser UI does not need these — credentials are stored via the guided setup.',
		fix: 'Add the three COMPANY_OS_LLM_* lines to company-os/.env (or configure through the UI).'
	});

	// database reachable
	if (url) {
		try {
			const { connect } = await import('../src/lib/server/db.ts');
			const sql = connect(url);
			await sql`select 1`;
			await sql.end();
			results.push({ name: 'database reachable', ok: true });
		} catch (cause) {
			results.push({
				name: 'database reachable',
				ok: false,
				detail: (cause as Error).message,
				fix: 'Start Postgres (npm run db:up in the repo root) and check COMPANY_OS_DATABASE_URL.'
			});
		}
	}

	// git
	const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
	results.push({
		name: 'git available (site repos are committed per render)',
		ok: gitVersion.status === 0,
		detail: gitVersion.stdout?.trim(),
		fix: 'Install git.'
	});

	// sites dir writable
	const sitesDir = process.env.COMPANY_OS_SITES_DIR;
	if (sitesDir) {
		try {
			if (!existsSync(sitesDir)) {
				const { mkdirSync } = await import('node:fs');
				mkdirSync(sitesDir, { recursive: true });
			}
			statSync(sitesDir).isDirectory();
			results.push({ name: `COMPANY_OS_SITES_DIR exists and is usable (${sitesDir})`, ok: true });
		} catch (cause) {
			results.push({
				name: `COMPANY_OS_SITES_DIR usable`,
				ok: false,
				detail: (cause as Error).message,
				fix: `Create the directory: mkdir -p ${sitesDir}`
			});
		}
	}

	// playwright browsers (only needed for e2e)
	const pwCache = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright');
	results.push({
		name: 'Playwright browsers installed (needed for `co e2e`)',
		ok: existsSync(pwCache),
		detail: existsSync(pwCache) ? undefined : `${pwCache} not found`,
		fix: 'Run: npx playwright install chromium'
	});

	let broken = 0;
	for (const r of results) {
		if (!r.ok) broken += 1;
		console.log(`${r.ok ? '✓' : '✗'} ${r.name}`);
		if (r.detail) console.log(`    ${r.detail}`);
		if (!r.ok && r.fix) console.log(`    fix: ${r.fix}`);
	}
	console.log(
		broken === 0
			? '\ndoctor: PASS — everything the product needs is in place.'
			: `\ndoctor: ${broken} problem(s) found. Fix them and run again — nothing will work until then.`
	);
	return broken === 0 ? 0 : 1;
}

function loadEnvFile(): void {
	const file = join(ROOT, '.env');
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
		if (match && process.env[match[1]!] === undefined) {
			process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
		}
	}
}

main()
	.then((code) => process.exit(code))
	.catch((cause: Error) => {
		console.error(`co crashed: ${cause.message}`);
		process.exit(1);
	});
