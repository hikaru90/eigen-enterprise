import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { buildRuntime, runTurn } from '$lib/server/service';

/**
 * POST /api/turn — one founder message, streamed back as SSE loop events.
 * The process state lives server-side; the client just renders honestly.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as
		| { sessionId?: string; message?: string }
		| null;
	const message = body?.message?.trim();
	const sessionId = body?.sessionId;
	if (!sessionId || !message) {
		return json({ error: 'sessionId and message are required.' }, { status: 400 });
	}

	const runtime = await buildRuntime(env);
	if (!runtime) {
		return json({ error: 'Provider not configured — complete the setup first.' }, { status: 409 });
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: unknown): void => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};
			try {
				// Live streaming: events go out as they happen — during a render
				// (draft, audit, commit) the founder watches named progress lines,
				// never a bare spinner (first-conversation.md rule 2).
				await runTurn(runtime.deps, sessionId, message, (event) => send(event));
				send({ type: 'done' });
			} catch (cause) {
				send({ type: 'error', message: (cause as Error).message });
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
