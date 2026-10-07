/**
 * The reveal surface (P3): serve the committed site, exactly as committed.
 * The founder's first look must be the artifact itself — no re-render, no
 * drift between what git holds and what the browser shows.
 */

import type { MemoryStore } from './memory.ts';
import { committedFile, siteDirFor } from './site-store.ts';

export class PreviewError extends Error {}

export async function previewHtml(memory: MemoryStore, sitesDir: string): Promise<string> {
	const renderEntry = (await memory.latest()).find((e) => e.kind === 'render' && e.key === 'website');
	if (!renderEntry) {
		throw new PreviewError('The website has never been rendered — nothing to preview yet.');
	}
	const { company } = JSON.parse(renderEntry.value) as { company?: string };
	if (!company) {
		throw new PreviewError(`The render record is missing its company name: ${renderEntry.value}`);
	}
	const html = committedFile(siteDirFor(sitesDir, company), 'index.html');
	if (html === null) {
		throw new PreviewError(`No committed index.html for "${company}" — the render record and the site repo disagree.`);
	}
	return html;
}
