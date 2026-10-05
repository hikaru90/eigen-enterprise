/**
 * The reasoning loop (company-os-architecture.md §6.1): reason → tool → observe,
 * streamed as events so surfaces can render progress lines, never bare spinners.
 *
 * Fails loud on runaway loops — no silent truncation (no-fallbacks rule).
 */

import type { LlmClient, ChatMessage, ToolCall } from './llm.ts';
import type { ToolContext, ToolRegistry } from './tools.ts';

export type LoopEvent =
	| { type: 'text_delta'; text: string }
	| { type: 'assistant_message'; message: ChatMessage }
	| { type: 'tool_call'; call: ToolCall }
	| { type: 'tool_result'; call: ToolCall; result: string; isError: boolean }
	| { type: 'finish'; reason: 'completed'; messages: ChatMessage[] };

export type LoopOptions<C extends ToolContext = ToolContext> = {
	client: LlmClient;
	registry: ToolRegistry<C>;
	ctx: C;
	/** Conversation so far; never mutated — the finished transcript comes on `finish`. */
	messages: ChatMessage[];
	/** Safety bound. Exceeding it throws — a stuck loop must be visible, not swallowed. */
	maxSteps?: number;
	temperature?: number;
}

const DEFAULT_MAX_STEPS = 8;

export async function* runLoop<C extends ToolContext = ToolContext>(
	opts: LoopOptions<C>
): AsyncGenerator<LoopEvent> {
	const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
	const messages = [...opts.messages];

	for (let step = 0; step < maxSteps; step++) {
		let text = '';
		const pendingCalls: ToolCall[] = [];

		for await (const event of opts.client.stream({
			messages,
			tools: opts.registry.toApiTools(),
			temperature: opts.temperature
		})) {
			if (event.type === 'text_delta') {
				text += event.text;
				yield event;
			} else if (event.type === 'tool_calls') {
				pendingCalls.push(...event.toolCalls);
			}
		}

		const assistantMessage: ChatMessage = pendingCalls.length
			? { role: 'assistant', content: text.length > 0 ? text : null, tool_calls: pendingCalls }
			: { role: 'assistant', content: text };
		messages.push(assistantMessage);
		yield { type: 'assistant_message', message: assistantMessage };

		if (pendingCalls.length === 0) {
			yield { type: 'finish', reason: 'completed', messages };
			return;
		}

		for (const call of pendingCalls) {
			yield { type: 'tool_call', call };
			let result: string;
			let isError = false;
			try {
				result = stringifyResult(await opts.registry.execute(call, opts.ctx));
			} catch (cause) {
				// The error IS the observation — the agent sees it and can recover.
				isError = true;
				result = `ERROR: ${(cause as Error).message}`;
			}
			messages.push({ role: 'tool', tool_call_id: call.id, content: result });
			yield { type: 'tool_result', call, result, isError };
		}
	}

	throw new Error(
		`Agent loop exceeded maxSteps (${maxSteps}) without completing — refusing to silently truncate.`
	);
}

function stringifyResult(value: unknown): string {
	if (typeof value === 'string') return value;
	const json = JSON.stringify(value, null, 2);
	return json === undefined ? String(value) : json;
}
