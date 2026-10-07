/**
 * The mock LLM gateway — an OpenAI-compatible streaming endpoint with a
 * SCRIPTED future. E2E drives the real product against this: wire format,
 * SSE chunking (including split tool-call arguments) and failure modes are
 * real; only the model is scripted.
 *
 * A model request that outlives the script fails LOUD with the actual
 * request summary — product drift and test drift are both visible, never
 * absorbed.
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** One scripted model turn: the SSE chunk payloads, in order. */
export type ScriptedTurn = Record<string, unknown>[];

/** A scripted non-200 response (e.g. the provider's 401) — served instead of an SSE stream. */
export interface ScriptedHttpError {
	httpError: { status: number; body: unknown };
}
export type ScriptEntry = ScriptedTurn | ScriptedHttpError;

function isHttpError(entry: ScriptEntry): entry is ScriptedHttpError {
	return 'httpError' in entry;
}

interface RecordedRequest {
	url: string;
	model?: string;
	messageCount?: number;
	lastContent?: string;
	lastToolName?: string;
}

export class MockLlmGateway {
	private script: ScriptEntry[] = [];
	readonly requests: RecordedRequest[] = [];
	private readonly server: Server;
	private started = false;

	constructor() {
		this.server = createServer((req, res) => {
			void this.handle(req, res);
		});
	}

	/** Load a script (replaces any previous one; request log survives). */
	loadScript(turns: ScriptEntry[]): void {
		this.script = [...turns];
	}

	get remaining(): number {
		return this.script.length;
	}

	async start(port = 0): Promise<string> {
		if (this.started) throw new Error('MockLlmGateway already started.');
		const url = await new Promise<string>((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(port, '127.0.0.1', () => {
				const address = this.server.address();
				if (!address || typeof address === 'string') {
					reject(new Error('mock gateway has no port'));
					return;
				}
				resolve(`http://127.0.0.1:${address.port}/v1`);
			});
		});
		this.started = true;
		return url;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method === 'POST' && req.url === '/v1/chat/completions') {
			this.handleCompletion(req, res);
			return;
		}
		if (req.method === 'POST' && req.url === '/__script') {
			let raw = '';
			req.on('data', (chunk: Buffer) => (raw += chunk));
			req.on('end', () => {
				try {
					const body = JSON.parse(raw) as { turns?: ScriptEntry[] };
					if (!Array.isArray(body.turns)) throw new Error('body must be { turns: [...] }');
					this.loadScript(body.turns);
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ loaded: body.turns.length }));
				} catch (cause) {
					res.writeHead(400, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ error: (cause as Error).message }));
				}
			});
			return;
		}
		if (req.method === 'GET' && req.url === '/__requests') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(this.requests, null, 2));
			return;
		}
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: `mock gateway has no route ${req.method} ${req.url}` }));
	}

	private handleCompletion(req: IncomingMessage, res: ServerResponse): void {
		let raw = '';
		req.on('data', (chunk: Buffer) => (raw += chunk));
		req.on('end', () => {
			const recorded = this.record(raw);
			const entry = this.script.shift();
			if (!entry) {
				res.writeHead(500, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						error:
							'mock gateway: script exhausted — the product made a model call the test did not script. ' +
							`Request was: ${JSON.stringify(recorded)}`
					})
				);
				return;
			}
			if (isHttpError(entry)) {
				res.writeHead(entry.httpError.status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(entry.httpError.body));
				return;
			}
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive'
			});
			for (const chunk of entry) {
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			}
			res.write('data: [DONE]\n\n');
			res.end();
		});
	}

	private record(raw: string): RecordedRequest {
		let entry: RecordedRequest = { url: '/v1/chat/completions' };
		try {
			const body = JSON.parse(raw) as {
				model?: string;
				messages?: { role: string; content?: string | null; tool_calls?: { function: { name: string } }[] }[];
			};
			const last = body.messages?.at(-1);
			entry = {
				url: '/v1/chat/completions',
				model: body.model,
				messageCount: body.messages?.length,
				lastContent: typeof last?.content === 'string' ? last.content.slice(0, 160) : undefined,
				lastToolName: last?.tool_calls?.[0]?.function.name
			};
		} catch {
			// unparseable body — recorded as-is above
		}
		this.requests.push(entry);
		return entry;
	}
}

/* ---------- chunk builders (exercise the real client's assembly) ---------- */

let chunkId = 0;
function nextId(): string {
	chunkId += 1;
	return `chatcmpl-mock-${chunkId}`;
}

export function textTurn(text: string): ScriptedTurn {
	const id = nextId();
	return [
		{ id, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
		{ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
	];
}

/**
 * A tool-call turn. Arguments are split across TWO chunks to exercise the
 * client's index-based assembly — real providers split them, so the mock must.
 */
export function toolTurn(prefixText: string, calls: { id: string; name: string; args: unknown }[]): ScriptedTurn {
	const id = nextId();
	const chunks: Record<string, unknown>[] = [];
	if (prefixText.length > 0) {
		chunks.push({ id, choices: [{ index: 0, delta: { role: 'assistant', content: prefixText }, finish_reason: null }] });
	}
	calls.forEach((call, index) => {
		const args = JSON.stringify(call.args);
		const half = Math.max(1, Math.floor(args.length / 2));
		chunks.push({
			id,
			choices: [
				{
					index: 0,
					delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] },
					finish_reason: null
				}
			]
		});
		chunks.push({
			id,
			choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(0, half) } }] }, finish_reason: null }]
		});
		chunks.push({
			id,
			choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] }, finish_reason: null }]
		});
	});
	chunks.push({ id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
	return chunks;
}

export const finishStopOnly = (text = ''): ScriptedTurn => textTurn(text);
