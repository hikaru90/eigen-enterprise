/**
 * The e2e stack harness: starts the REAL product against REAL infrastructure
 * that the test controls at the edges.
 *
 *   real Postgres  → a disposable database (`company_os_e2e`) recreated per run
 *   real git       → sites committed into a temp dir
 *   real server    → production build (adapter-node) on a known port
 *   scripted LLM   → the mock gateway (wire-compatible, loud on deviation)
 *
 * Only the model is fake. Everything else is exactly what the founder runs.
 */

import type { ScriptEntry } from './mock-llm.ts';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect } from '../src/lib/server/db.ts';
import { loadDotEnv } from '../src/lib/server/dotenv.ts';
import { migrate } from '../src/lib/server/migrate.ts';
import { MockLlmGateway } from './mock-llm.ts';

const COMPANY_OS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const E2E_DB_NAME = 'company_os_e2e';
export const MOCK_PORT = Number.parseInt(process.env.E2E_MOCK_PORT ?? '5177', 10);
export const SERVER_PORT = Number.parseInt(process.env.E2E_SERVER_PORT ?? '5178', 10);

export function devDatabaseUrl(): string {
	loadDotEnv(process.env, COMPANY_OS_ROOT);
	const url = process.env.COMPANY_OS_DATABASE_URL;
	if (!url) {
		throw new Error(
			'COMPANY_OS_DATABASE_URL is required to derive the e2e database (same Postgres server, dedicated `company_os_e2e` database).'
		);
	}
	return url;
}

/** Same server as the dev database, dedicated e2e database name. */
export function e2eDatabaseUrl(devUrl = devDatabaseUrl()): string {
	const parsed = new URL(devUrl);
	parsed.pathname = `/${E2E_DB_NAME}`;
	return parsed.toString();
}

async function recreateDatabase(devUrl: string): Promise<void> {
	const admin = postgres(devUrl, { database: 'postgres', max: 1 });
	try {
		await admin.unsafe(`drop database if exists ${E2E_DB_NAME} with (force)`);
		await admin.unsafe(`create database ${E2E_DB_NAME}`);
	} finally {
		await admin.end();
	}
}

export type Stack = {
	mockUrl: string;
	baseUrl: string;
	sitesDir: string;
	dbUrl: string;
	gateway: MockLlmGateway;
	serverProcess: ReturnType<typeof spawn>;
	loadScript(script: ScriptEntry[]): void;
	stop(): Promise<void>;
}

export type StackOptions = {
	script: ScriptEntry[];
	/** Skip `npm run build` when the build is already fresh (iteration speed). */
	skipBuild?: boolean;
	serverPort?: number;
}

export async function startStack(opts: StackOptions): Promise<Stack> {
	const devUrl = devDatabaseUrl();
	const dbUrl = e2eDatabaseUrl(devUrl);
	await recreateDatabase(devUrl);

	const migrationsDir = join(COMPANY_OS_ROOT, 'migrations');
	const sql = connect(dbUrl);
	try {
		const ran = await migrate(sql, migrationsDir);
		console.log(`[harness] migrations applied: ${ran.length}`);
	} finally {
		await sql.end();
	}

	const gateway = new MockLlmGateway();
	gateway.loadScript(opts.script);
	const mockUrl = await gateway.start(MOCK_PORT);
	console.log(`[harness] mock LLM gateway at ${mockUrl}`);

	const sitesDir = mkdtempSync(join(tmpdir(), 'co-e2e-sites-'));

	if (!opts.skipBuild || !existsSync(join(COMPANY_OS_ROOT, 'build', 'index.js'))) {
		console.log('[harness] building production bundle…');
		execSync('npm run build', { cwd: COMPANY_OS_ROOT, stdio: 'inherit', env: process.env });
	}

	const serverPort = opts.serverPort ?? SERVER_PORT;
	// A busy port means a stale stack is answering — the readiness probe would
	// pass against the WRONG server and every assertion would lie. Fail loud.
	const portBusy = await new Promise<boolean>((resolve) => {
		const probe = createConnection(serverPort, '127.0.0.1');
		probe.once('connect', () => {
			probe.destroy();
			resolve(true);
		});
		probe.once('error', () => resolve(false));
	});
	if (portBusy) {
		await gateway.stop();
		throw new Error(
			`[harness] port ${serverPort} is already in use — a stale server is answering. ` +
				'Kill it (lsof -i :' + serverPort + ') and rerun; assertions against the wrong server are lies.'
		);
	}
	const serverProcess = spawn('node', ['build/index.js'], {
		cwd: COMPANY_OS_ROOT,
		env: {
			...process.env,
			PORT: String(serverPort),
			COMPANY_OS_DATABASE_URL: dbUrl,
			COMPANY_OS_SITES_DIR: sitesDir
			// Deliberately NO COMPANY_OS_LLM_* here: env config would bypass the
			// guided setup. The founder path stores credentials in the DB (the
			// mock gateway), and that is what must be tested.
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const serverLogs: string[] = [];
	serverProcess.stdout.on('data', (d: Buffer) => serverLogs.push(d.toString()));
	serverProcess.stderr.on('data', (d: Buffer) => serverLogs.push(d.toString()));
	serverProcess.on('exit', (code) => {
		if (code !== null && code !== 0) {
			console.error(`[harness] server exited with ${code}:\n${serverLogs.join('')}`);
		}
	});

	const baseUrl = `http://127.0.0.1:${serverPort}`;
	const ready = await waitFor(`${baseUrl}/`, 30_000);
	if (!ready) {
		await gateway.stop();
		serverProcess.kill('SIGKILL');
		throw new Error(`[harness] server did not become ready at ${baseUrl} — logs:\n${serverLogs.join('')}`);
	}
	console.log(`[harness] server ready at ${baseUrl}`);

	return {
		mockUrl,
		baseUrl,
		sitesDir,
		dbUrl,
		gateway,
		serverProcess,
		loadScript(script: ScriptEntry[]): void {
			gateway.loadScript(script);
		},
		async stop(): Promise<void> {
			serverProcess.kill('SIGTERM');
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					serverProcess.kill('SIGKILL');
					resolve();
				}, 3000);
				serverProcess.once('exit', () => {
					clearTimeout(timer);
					resolve();
				});
			});
			await gateway.stop();
			rmSync(sitesDir, { recursive: true, force: true });
		}
	};
}

export async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return true;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}
