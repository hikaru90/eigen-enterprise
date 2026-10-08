import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMemoryStore, type MemoryStore } from './memory.ts';
import { previewHtml } from './preview.ts';
import { renderSiteCommit, siteDirFor } from './site-store.ts';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'co-preview-'));
});

async function memoryWithRender(company: string): Promise<MemoryStore> {
	const memory = new InMemoryMemoryStore();
	await memory.remember({ kind: 'answer', key: 'company.name', value: company });
	await memory.remember({
		kind: 'render',
		key: 'website',
		value: JSON.stringify({ company, version: '0.1', commit: 'abc' })
	});
	return memory;
}

describe('previewHtml — the reveal surface serves exactly what was committed', () => {
	it('returns the committed index.html for the rendered company', async () => {
		const memory = await memoryWithRender('Hafenlicht');
		const siteDir = siteDirFor(dir, 'Hafenlicht');
		renderSiteCommit(siteDir, { 'index.html': '<h1>Hafenlicht</h1>' });

		const html = await previewHtml(memory, dir);
		expect(html).toContain('<h1>Hafenlicht</h1>');
	});

	it('the preview reflects the LATEST commit, not a stale copy', async () => {
		const memory = await memoryWithRender('Hafenlicht');
		const siteDir = siteDirFor(dir, 'Hafenlicht');
		renderSiteCommit(siteDir, { 'index.html': '<h1>v1</h1>' });
		renderSiteCommit(siteDir, { 'index.html': '<h1>v2</h1>' });

		const html = await previewHtml(memory, dir);
		expect(html).toContain('<h1>v2</h1>');
	});

	it('fails honest when nothing was ever rendered', async () => {
		const memory = new InMemoryMemoryStore();
		await expect(previewHtml(memory, dir)).rejects.toThrow(/never been rendered/);
	});

	it('fails honest when the render is recorded but the repo is missing', async () => {
		const memory = await memoryWithRender('Hafenlicht');
		await expect(previewHtml(memory, dir)).rejects.toThrow(/No committed index\.html/);
	});
});
