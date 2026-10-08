import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMemoryStore, type MemoryStore } from '../../src/lib/server/memory.ts';
import { siteDirFor } from '../../src/lib/server/site-store.ts';
import { FakeClient, finishStop, text } from '../../src/lib/server/testing.ts';
import { performRender, renderWebsiteTool, websiteManifest, WEBSITE_MANIFEST, DEFAULT_THEME_CSS } from './index.ts';

const DRAFT = {
	schema: 'company-os/website@0.1',
	language: 'de',
	company: { name: 'Bäckerei Hinkel' },
	sections: [
		{
			type: 'hero',
			headline: 'Frisches Brot seit 1911',
			subline: 'Sauerteig aus Ehrenfeld',
			sources: ['company.name', 'company.differentiator']
		},
		{
			type: 'about',
			title: 'Unsere Bäckerei',
			body: ['Wir backen nach dem Rezept von 1911.'],
			sources: ['company.differentiator']
		}
	]
};

/** The real in-memory store (same contract as PgMemoryStore.latest), seeded with the founder's answers. */
async function answersMemory(): Promise<MemoryStore> {
	const memory = new InMemoryMemoryStore();
	const entry = (key: string, value: string): Parameters<MemoryStore['remember']>[0] => ({
		kind: 'answer',
		key,
		value
	});
	await memory.remember(entry('company.name', 'Bäckerei Hinkel'));
	await memory.remember(entry('company.audience', 'Familien in Ehrenfeld'));
	await memory.remember(entry('company.cta', 'Vorbestellung per E-Mail an brot@hinkel.de'));
	await memory.remember(entry('company.tone', 'herzlich, handgemacht'));
	await memory.remember(entry('company.differentiator', 'Seit 1911 gleiches Sauerteigrezept'));
	await memory.remember(entry('site.language', 'Deutsch'));
	return memory;
}

/** Tests script the transport; the module only sees the LlmClient shape. */
function asClient(fake: FakeClient): import('../../src/lib/server/llm.ts').LlmClient {
	return fake as unknown as import('../../src/lib/server/llm.ts').LlmClient;
}

function draftClient(): FakeClient {
	return new FakeClient([
		[text(JSON.stringify(DRAFT)), finishStop],
		[text(JSON.stringify({ violations: [] })), finishStop]
	]);
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'co-website-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('websiteManifest', () => {
	it('declares the same content contract the code enforces', () => {
		const manifest = websiteManifest();
		expect(manifest.name).toBe('website');
		expect(manifest.content.schema).toBe('company-os/website@0.1');
		expect(manifest.content.sectionTypes).toEqual(['hero', 'about', 'differentiator', 'offer', 'cta']);
		expect(manifest.tools.map((t) => t.name)).toContain('render_website');
	});
});

describe('module artifacts stay in sync with the runtime constants', () => {
	const moduleDir = join(dirname(fileURLToPath(import.meta.url)));

	it('module.json on disk declares exactly what the code runs', () => {
		const onDisk = JSON.parse(readFileSync(join(moduleDir, 'module.json'), 'utf8'));
		expect(onDisk).toEqual(WEBSITE_MANIFEST);
	});

	it('theme.css on disk is the theme the renderer inlines', () => {
		expect(readFileSync(join(moduleDir, 'theme.css'), 'utf8')).toBe(DEFAULT_THEME_CSS);
	});
});

describe('performRender', () => {
	it('drafts from the answers, audits, renders and commits version 0.1', async () => {
		const client = draftClient();
		const out = await performRender({
			client: asClient(client),
			memory: await answersMemory(),
			sitesDir: dir
		});

		expect(out.version).toBe('0.1');
		expect(out.previewPath).toBe('/site');
		expect(out.company).toBe('Bäckerei Hinkel');

		const html = out.files['index.html']!;
		expect(html).toContain('Frisches Brot seit 1911');
		expect(html).toContain('<html lang="de">');
		const contentJson = JSON.parse(out.files['content.json']!) as { sections: unknown[] };
		expect(contentJson.sections.length).toBeGreaterThan(0);
		expect(out.files['theme.css']).toBeDefined();
	});

	it('two renders produce two commits and a bumped version', async () => {
		const first = await performRender({ client: asClient(draftClient()), memory: await answersMemory(), sitesDir: dir });
		const second = await performRender({ client: asClient(draftClient()), memory: await answersMemory(), sitesDir: dir });
		expect(first.version).toBe('0.1');
		expect(second.version).toBe('0.2');
	});

	it('nothing is committed when the audit rejects the copy', async () => {
		const client = new FakeClient([
			[text(JSON.stringify(DRAFT)), finishStop],
			[
				text(
					JSON.stringify({
						violations: [{ section: 'about', sentence: 'Kostet 3,50 €.', reason: 'price was never given' }]
					})
				),
				finishStop
			]
		]);
		await expect(performRender({ client: asClient(client), memory: await answersMemory(), sitesDir: dir })).rejects.toThrow(/3,50/);
		const siteDir = siteDirFor(dir, 'Bäckerei Hinkel');
		expect(existsSync(join(siteDir, '.git'))).toBe(false);
		expect(existsSync(join(siteDir, 'index.html'))).toBe(false);
	});
});

describe('renderWebsiteTool', () => {
	it('is a registered-shaped tool whose execute renders and returns the reveal facts', async () => {
		const tool = renderWebsiteTool({ client: asClient(draftClient()), getSitesDir: () => dir });
		expect(tool.name).toBe('render_website');
		expect(tool.haltsTurn).toBe(false);

		const ctx = { memory: await answersMemory() };
		const result = (await tool.execute({}, ctx)) as { version: string; previewPath: string };
		expect(result.version).toBe('0.1');
		expect(result.previewPath).toBe('/site');
		const renderEntry = (await ctx.memory.latest()).find((e) => e.kind === 'render' && e.key === 'website');
		expect(renderEntry).toBeDefined();
		expect(JSON.parse(renderEntry!.value)).toMatchObject({ company: 'Bäckerei Hinkel', version: '0.1' });
	});

	it('fails loud when the founder never said the company name', async () => {
		const tool = renderWebsiteTool({ client: asClient(draftClient()), getSitesDir: () => dir });
		const ctx = { memory: new InMemoryMemoryStore() };
		await expect(tool.execute({}, ctx)).rejects.toThrow(/company\.name/);
	});
});
