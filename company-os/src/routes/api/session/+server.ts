import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { buildRuntime, ensureSession } from '$lib/server/service';

/** POST /api/session — bootstrap: guided setup gate first, then arrival/resume. */
export const POST: RequestHandler = async () => {
	let runtime;
	try {
		runtime = await buildRuntime(env);
	} catch (cause) {
		return json({ providerConfigured: false, substrateError: (cause as Error).message });
	}
	if (!runtime) return json({ providerConfigured: false });

	try {
		const bootstrap = await ensureSession(runtime.deps);
		return json({ providerConfigured: true, ...bootstrap });
	} catch (cause) {
		return json(
			{ providerConfigured: true, error: (cause as Error).message },
			{ status: 500 }
		);
	}
};
