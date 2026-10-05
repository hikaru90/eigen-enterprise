import { describe, expect, it } from 'vitest';
import { runLoop } from './loop.ts';
import type { LoopEvent } from './loop.ts';
import { LlmClient } from './llm.ts';
import type { ChatMessage, ChatParams, StreamEvent } from './llm.ts';
import { ToolRegistry } from './tools.ts';
import type { ToolContext } from './tools.ts';

/** Scripted client: yields prepared stream events per call, records params. */
class FakeClient {
	calls: ChatParams[] = [];
	constructor(private readonly turns: StreamEvent[][]) {}

	async *stream(params: ChatParams): AsyncGenerator<StreamEvent> {
		this.calls.push(params);
		const turn = this.turns.shift();
		if (!turn) throw new Error('FakeClient ran out of scripted turns');
		for (const event of turn) yield event;
	}

	asClient(): LlmClient {
		return this as unknown as LlmClient;
	}
}

const ctx: ToolContext = {};

function registryWithCounter(counter: { value: number }): ToolRegistry {
	const registry = new ToolRegistry();
	registry.register({
		name: 'increment',
		description: 'Increments the counter',
		parameters: { type: 'object', properties: {} },
		execute: () => {
			counter.value += 1;
			return { value: counter.value };
		}
	});
	return registry;
}

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
	const out: LoopEvent[] = [];
	for await (const event of gen) out.push(event);
	return out;
}

describe('runLoop', () => {
	it('streams text, executes tools, observes, and finishes with the full transcript', async () => {
		const counter = { value: 0 };
		const client = new FakeClient([
			[
				{ type: 'text_delta', text: 'Saving that.' },
				{
					type: 'tool_calls',
					toolCalls: [{ id: 'c1', type: 'function', function: { name: 'increment', arguments: '{}' } }]
				},
				{ type: 'finish', finishReason: 'tool_calls' }
			],
			[
				{ type: 'text_delta', text: 'Done — saved.' },
				{ type: 'finish', finishReason: 'stop' }
			]
		]);
		const input: ChatMessage[] = [{ role: 'user', content: 'remember this' }];
		const events = await collect(
			runLoop({ client: client.asClient(), registry: registryWithCounter(counter), ctx, messages: input })
		);

		expect(counter.value).toBe(1);
		expect(events.map((e) => e.type)).toEqual([
			'text_delta',
			'assistant_message',
			'tool_call',
			'tool_result',
			'text_delta',
			'assistant_message',
			'finish'
		]);
		const toolResult = events.find((e) => e.type === 'tool_result');
		expect(toolResult).toMatchObject({ isError: false, result: '{\n  "value": 1\n}' });
		const finish = events.at(-1) as Extract<LoopEvent, { type: 'finish' }>;
		expect(finish.reason).toBe('completed');
		expect(finish.messages).toHaveLength(4); // user + assistant(tool_calls) + tool + assistant(text)
		expect(finish.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{\n  "value": 1\n}' });
		// input never mutated
		expect(input).toEqual([{ role: 'user', content: 'remember this' }]);
	});

	it('sends tool errors back as observations and continues', async () => {
		const registry = new ToolRegistry();
		registry.register({
			name: 'fail',
			description: 'Always throws',
			parameters: { type: 'object', properties: {} },
			execute: () => {
				throw new Error('disk on fire');
			}
		});
		const client = new FakeClient([
			[
				{ type: 'tool_calls', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'fail', arguments: '{}' } }] },
				{ type: 'finish', finishReason: 'tool_calls' }
			],
			[{ type: 'text_delta', text: 'The tool failed; reporting honestly.' }, { type: 'finish', finishReason: 'stop' }]
		]);
		const events = await collect(
			runLoop({ client: client.asClient(), registry, ctx, messages: [{ role: 'user', content: 'go' }] })
		);
		const toolResult = events.find((e) => e.type === 'tool_result');
		expect(toolResult).toMatchObject({ isError: true, result: 'ERROR: disk on fire' });
		const secondCallMessages = client.calls[1]!.messages;
		expect(secondCallMessages.at(-2)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ERROR: disk on fire' });
		expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed' });
	});

	it('throws loud when maxSteps is exceeded — no silent truncation', async () => {
		const counter = { value: 0 };
		const turn: StreamEvent[] = [
			{
				type: 'tool_calls',
				toolCalls: [{ id: 'loop', type: 'function', function: { name: 'increment', arguments: '{}' } }]
			},
			{ type: 'finish', finishReason: 'tool_calls' }
		];
		const client = new FakeClient([turn, turn]); // more tool-happy turns than steps allowed
		await expect(
			collect(
				runLoop({
					client: client.asClient(),
					registry: registryWithCounter(counter),
					ctx,
					messages: [{ role: 'user', content: 'go' }],
					maxSteps: 2
				})
			)
		).rejects.toThrowError(/exceeded maxSteps \(2\)/);
	});

	it('passes the registry schemas to every model call', async () => {
		const client = new FakeClient([[{ type: 'text_delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }]]);
		await collect(
			runLoop({
				client: client.asClient(),
				registry: registryWithCounter({ value: 0 }),
				ctx,
				messages: [{ role: 'user', content: 'hi' }]
			})
		);
		expect(client.calls[0]!.tools).toEqual([
			{
				type: 'function',
				function: {
					name: 'increment',
					description: 'Increments the counter',
					parameters: { type: 'object', properties: {} }
				}
			}
		]);
	});
});
