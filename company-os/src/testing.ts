/** Scripted LLM client for tests: yields prepared stream events per call. */
import type { ChatParams, StreamEvent } from './llm.ts';

export class FakeClient {
	calls: ChatParams[] = [];
	private turns: StreamEvent[][];

	constructor(turns: StreamEvent[][]) {
		this.turns = [...turns];
	}

	async *stream(params: ChatParams): AsyncGenerator<StreamEvent> {
		this.calls.push(params);
		const turn = this.turns.shift();
		if (!turn) throw new Error('FakeClient ran out of scripted turns');
		for (const event of turn) yield event;
	}
}

export const toolCall = (
	id: string,
	name: string,
	args: Record<string, unknown>
): StreamEvent => ({
	type: 'tool_calls',
	toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
});

export const finishStop: StreamEvent = { type: 'finish', finishReason: 'stop' };
export const finishToolCalls: StreamEvent = { type: 'finish', finishReason: 'tool_calls' };
export const text = (t: string): StreamEvent => ({ type: 'text_delta', text: t });
