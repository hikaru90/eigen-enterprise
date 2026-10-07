/**
 * The site store — the founder's ownership artifact (decision W4).
 *
 * The generated website is committed to its own git repository from the FIRST
 * render ("even version 0.1 is committed"). The repo lives under
 * COMPANY_OS_SITES_DIR (required, fail loud — no-fallbacks rule). The commit
 * identity is provided by the store so the artifact never depends on the
 * host's git config.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function sitesDirFromEnv(env: NodeJS.ProcessEnv): string {
	const dir = env.COMPANY_OS_SITES_DIR;
	if (!dir) {
		throw new Error(
			'COMPANY_OS_SITES_DIR is required — it is where generated websites are committed as git repositories. ' +
				'Add a line `COMPANY_OS_SITES_DIR=/absolute/path` to your .env and retry. The OS does not guess.'
		);
	}
	return dir;
}

/** Filesystem-safe per-company directory under the sites root. */
export function siteDirFor(sitesDir: string, companyName: string): string {
	const slug = companyName
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return join(sitesDir, slug.length > 0 ? slug : 'company');
}

const GIT_IDENTITY = ['-c', 'user.name=company-os', '-c', 'user.email=agent@company-os.local'];

function git(cwd: string, args: string[]): string {
	try {
		return execFileSync('git', ['-C', cwd, ...GIT_IDENTITY, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		});
	} catch (cause) {
		const err = cause as { stderr?: Buffer | string; message: string };
		const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? '';
		throw new Error(`git ${args[0]} failed: ${stderr.trim() || err.message}`);
	}
}

export interface RenderCommit {
	version: string;
	commit: string;
}

/**
 * Write the rendered files and commit them. First call inits the repo;
 * every call produces exactly one commit (`render: v<version> …`).
 * A dirty tree after the call is impossible — `add -A` + commit is atomic
 * enough for the slice and any git failure is loud, with stderr.
 */
export function renderSiteCommit(siteDir: string, files: Record<string, string>): RenderCommit {
	const current = readVersion(siteDir);
	const version = bumpVersion(current);

	if (!existsSync(join(siteDir, '.git'))) {
		mkdirSync(siteDir, { recursive: true });
		git(siteDir, ['init', '--quiet']);
	}
	for (const [name, content] of Object.entries(files)) {
		const target = join(siteDir, name);
		mkdirSync(join(target, '..'), { recursive: true });
		writeFileSync(target, content);
	}
	writeFileSync(join(siteDir, '.render-version'), `${version}\n`);

	git(siteDir, ['add', '-A']);
	git(siteDir, ['commit', '--quiet', '-m', `render: v${version} from the founder's answers`]);
	const commit = git(siteDir, ['rev-parse', 'HEAD']).trim();
	return { version, commit };
}

export function readVersion(siteDir: string): string | null {
	const file = join(siteDir, '.render-version');
	if (!existsSync(file)) return null;
	return readFileSync(file, 'utf8').trim();
}

function bumpVersion(current: string | null): string {
	if (current === null) return '0.1';
	const [minor, patch] = current.split('.').map((n) => Number.parseInt(n, 10));
	if (minor === undefined || patch === undefined || Number.isNaN(minor) || Number.isNaN(patch)) {
		throw new Error(`Unparseable render version "${current}" — refusing to guess.`);
	}
	return `${minor}.${patch + 1}`;
}

/** Latest committed content of one file, or null when it was never committed. */
export function committedFile(siteDir: string, name: string): string | null {
	if (!existsSync(join(siteDir, '.git'))) return null;
	try {
		return git(siteDir, ['show', `HEAD:${name}`]);
	} catch {
		return null;
	}
}
