import { describe, expect, it } from 'vitest';
import { llmConfigFromEnv, LlmClient } from './llm.ts';
import type { Transport } from './llm.ts';

async function drain<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of gen) out.push(item);
	return out;
}

function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		}
	});
	return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sse(events: unknown[]): string[] {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
}

describe('llmConfigFromEnv', () => {
	it('throws loud naming the first missing variable', () => {
		expect(() => llmConfigFromEnv({})).toThrowError(/COMPANY_OS_LLM_BASE_URL/);
		expect(() => llmConfigFromEnv({ COMPANY_OS_LLM_BASE_URL: 'https://x/v1' })).toThrowError(
			/COMPANY_OS_LLM_API_KEY/
		);
		expect(() =>
			llmConfigFromEnv({ COMPANY_OS_LLM_BASE_URL: 'https://x/v1', COMPANY_OS_LLM_API_KEY: 'k' })
		).toThrowError(/COMPANY_OS_LLM_MODEL/);
	});

	it('returns config when all variables are present', () => {
		const config = llmConfigFromEnv({
			COMPANY_OS_LLM_BASE_URL: 'https://x/v1',
			COMPANY_OS_LLM_API_KEY: 'k',
			COMPANY_OS_LLM_MODEL: 'm'
		});
		expect(config).toEqual({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' });
	});
});

describe('LlmClient.stream', () => {
	const config = { baseUrl: 'https://llm.test/v1', apiKey: 'secret-key', model: 'test-model' };

	it('sends model, messages, stream flag and tools to the endpoint', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const transport: Transport = async (url, init) => {
			calls.push({ url, init });
			return sseResponse([...sse([{ choices: [{ delta: { content: '' }, finish_reason: 'stop' }] }]), 'data: [DONE]\n\n']);
		};
		const client = new LlmClient(config, transport);
		const messages = [{ role: 'user' as const, content: 'hi' }];
		const tools = [
			{ type: 'function' as const, function: { name: 't', description: 'd', parameters: { type: 'object' } } }
		];
		await drain(client.stream({ messages, tools }));

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('https://llm.test/v1/chat/completions');
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.model).toBe('test-model');
		expect(body.messages).toEqual(messages);
		expect(body.stream).toBe(true);
		expect(body.tools).toEqual(tools);
		expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer secret-key' });
	});

	it('yields text deltas in order', async () => {
		const transport: Transport = async () =>
			sseResponse([
				...sse([
					{ choices: [{ delta: { content: 'Hello' } }] },
					{ choices: [{ delta: { content: ' world' } }] },
					{ choices: [{ delta: {}, finish_reason: 'stop' }] }
				]),
				'data: [DONE]\n\n'
			]);
		const events = await drain(new LlmClient(config, transport).stream({ messages: [] }));
		const deltas = events.filter((e) => e.type === 'text_delta');
		expect(deltas).toEqual([{ type: 'text_delta', text: 'Hello' }, { type: 'text_delta', text: ' world' }]);
		expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
	});

	it('assembles tool calls spread across chunks by index', async () => {
		const transport: Transport = async () =>
			sseResponse([
				...sse([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: 'call_1', function: { name: 'write_copy', arguments: '{"head' } },
										{ index: 1, id: 'call_2', function: { name: 'commit', arguments: '{}' } }
									]
								}
							}
						]
					},
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'line":"Hi"}' } }] } }] },
					{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
				]),
				'data: [DONE]\n\n'
			]);
		const events = await drain(new LlmClient(config, transport).stream({ messages: [] }));
		const toolCallEvent = events.find((e) => e.type === 'tool_calls');
		expect(toolCallEvent).toEqual({
			type: 'tool_calls',
			toolCalls: [
				{ id: 'call_1', type: 'function', function: { name: 'write_copy', arguments: '{"headline":"Hi"}' } },
				{ id: 'call_2', type: 'function', function: { name: 'commit', arguments: '{}' } }
			]
		});
		expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'tool_calls' });
	});

	it('throws loud on a tool call that never got an id', async () => {
		const transport: Transport = async () =>
			sseResponse([
				...sse([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'x', arguments: '{}' } }] } }] }]),
				'data: [DONE]\n\n'
			]);
		await expect(drain(new LlmClient(config, transport).stream({ messages: [] }))).rejects.toThrowError(
			/without an id/
		);
	});

	it('throws loud with the HTTP status on API errors', async () => {
		const transport: Transport = async () => new Response('{"error":"boom"}', { status: 500 });
		await expect(drain(new LlmClient(config, transport).stream({ messages: [] }))).rejects.toThrowError(
			/HTTP 500.*boom/s
		);
	});

	it('throws loud on invalid JSON in the stream', async () => {
		const transport: Transport = async () => sseResponse(['data: {not-json}\n\n']);
		await expect(drain(new LlmClient(config, transport).stream({ messages: [] }))).rejects.toThrowError(
			/invalid JSON/
		);
	});
});
