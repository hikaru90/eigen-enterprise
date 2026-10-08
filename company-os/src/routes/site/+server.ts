import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { PgMemoryStore } from '$lib/server/memory';
import { PreviewError, previewHtml } from '$lib/server/preview';
import { coreStores } from '$lib/server/service';
import { sitesDirFromEnv } from '$lib/server/site-store';

/**
 * GET /site — the reveal (P3). Serves the committed index.html verbatim:
 * the founder sees the artifact, not a re-render of it.
 */
export const GET: RequestHandler = async () => {
	try {
		const stores = await coreStores(env);
		const memory = new PgMemoryStore(stores.sql);
		const html = await previewHtml(memory, sitesDirFromEnv(env));
		return new Response(html, {
			headers: { 'content-type': 'text/html; charset=utf-8' }
		});
	} catch (cause) {
		// Honest surfaces: "not rendered yet" is a 404 with the truth;
		// anything else is a loud 500 with the exact failure.
		const status = cause instanceof PreviewError ? 404 : 500;
		return json({ error: (cause as Error).message }, { status });
	}
};
