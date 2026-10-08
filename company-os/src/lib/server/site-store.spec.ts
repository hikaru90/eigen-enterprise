import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { renderSiteCommit, sitesDirFromEnv, siteDirFor } from './site-store.ts';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'co-sites-'));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

describe('sitesDirFromEnv', () => {
	it('fails loud with the exact env line when unset', () => {
		expect(() => sitesDirFromEnv({})).toThrow(/COMPANY_OS_SITES_DIR/);
		try {
			sitesDirFromEnv({});
		} catch (cause) {
			expect((cause as Error).message).toContain('COMPANY_OS_SITES_DIR=');
		}
	});

	it('returns the configured directory', () => {
		expect(sitesDirFromEnv({ COMPANY_OS_SITES_DIR: '/srv/sites' })).toBe('/srv/sites');
	});
});

describe('siteDirFor', () => {
	it('derives a filesystem-safe directory from the company name', () => {
		expect(siteDirFor('/srv/sites', 'Bäckerei Hinkel & Söhne')).toBe(
			join('/srv/sites', 'backerei-hinkel-sohne')
		);
	});

	it('collapses to a placeholder when nothing survives slugification', () => {
		expect(siteDirFor('/srv/sites', '???')).toBe(join('/srv/sites', 'company'));
	});
});

describe('renderSiteCommit', () => {
	it('creates the repo on first render and commits version 0.1', () => {
		const siteDir = siteDirFor(dir, 'Testfirma');
		const out = renderSiteCommit(siteDir, { 'index.html': '<h1>Testfirma</h1>' });

		expect(out.version).toBe('0.1');
		expect(git(siteDir, 'log', '--oneline')).toMatch(/render: v0\.1/);
		expect(git(siteDir, 'status', '--porcelain')).toBe('');
		expect(git(siteDir, 'show', 'HEAD:index.html')).toContain('Testfirma');
	});

	it('commits every render — even version 0.1 is committed, and each render is one commit', () => {
		const siteDir = siteDirFor(dir, 'Testfirma');
		renderSiteCommit(siteDir, { 'index.html': '<h1>v1</h1>' });
		const second = renderSiteCommit(siteDir, { 'index.html': '<h1>v2</h1>' });

		expect(second.version).toBe('0.2');
		const log = git(siteDir, 'log', '--oneline');
		expect(log.match(/render: v/g)?.length).toBe(2);
		expect(git(siteDir, 'show', 'HEAD:index.html')).toContain('v2');
	});

	it('writes the version marker file the renderer can read back', () => {
		const siteDir = siteDirFor(dir, 'Testfirma');
		renderSiteCommit(siteDir, { 'index.html': '<h1>x</h1>' });
		expect(git(siteDir, 'show', 'HEAD:.render-version')).toBe('0.1\n');
	});

	it('does not depend on the host git identity', () => {
		const siteDir = siteDirFor(dir, 'Testfirma');
		// No user.name/user.email configured anywhere for this repo — the commit
		// identity comes from the store itself.
		renderSiteCommit(siteDir, { 'index.html': '<h1>x</h1>' });
		const author = git(siteDir, 'log', '-1', '--format=%an <%ae>');
		expect(author).toMatch(/company-os/);
	});

	it('fails loud when the directory cannot be used', () => {
		const fileAsDir = join(dir, 'occupied');
		writeFileSync(fileAsDir, 'not a directory');
		expect(() => renderSiteCommit(join(fileAsDir, 'site'), {})).toThrow(/occupied/);
	});
});
