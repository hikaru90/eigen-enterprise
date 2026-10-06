import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { coreStores, verifyProviderSetup } from '$lib/server/service';
import type { ProviderSetup } from '$lib/server/service';

/**
 * POST /api/provider — the guided-setup endpoint: verify the credentials with
 * a real request, then store them in the founder's own database. No faked
 * readiness: a key that fails returns the provider's exact error.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Partial<ProviderSetup> | null;
	if (
		!body ||
		typeof body.baseUrl !== 'string' ||
		typeof body.apiKey !== 'string' ||
		typeof body.model !== 'string' ||
		!body.baseUrl.trim() ||
		!body.apiKey.trim() ||
		!body.model.trim()
	) {
		return json({ ok: false, error: 'Base URL, API key and model are all required.' }, { status: 400 });
	}
	const setup: ProviderSetup = {
		baseUrl: body.baseUrl.trim().replace(/\/+$/, ''),
		apiKey: body.apiKey.trim(),
		model: body.model.trim()
	};

	let stores;
	try {
		stores = await coreStores(env);
	} catch (cause) {
		return json(
			{ ok: false, error: `Cannot reach the database: ${(cause as Error).message}` },
			{ status: 500 }
		);
	}

	const verdict = await verifyProviderSetup(setup);
	if (!verdict.ok) {
		return json({ ok: false, error: verdict.error });
	}
	await stores.provider.save(setup);
	return json({ ok: true });
};
