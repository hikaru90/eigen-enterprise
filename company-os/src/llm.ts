/**
 * Minimal OpenAI-compatible streaming chat client.
 *
 * Phase-wedge decision W3: no provider matrix, no BYOK UI, no defaults.
 * Config comes from COMPANY_OS_LLM_* env vars and fails loud at call time.
 * Tests inject a transport explicitly — never a silent fallback.
 */

export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

/** Tool schema as sent to the LLM API (JSON-schema parameters). */
export interface ApiTool {
	type: 'function';
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

/**
 * Build config from env. Every variable is required — missing config is a
 * loud, actionable error, never a default.
 */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
	const baseUrl = env.COMPANY_OS_LLM_BASE_URL;
	if (!baseUrl) {
		throw new Error(
			'COMPANY_OS_LLM_BASE_URL is required (e.g. https://api.openai.com/v1). Set it and retry — the OS does not guess.'
		);
	}
	const apiKey = env.COMPANY_OS_LLM_API_KEY;
	if (!apiKey) {
		throw new Error('COMPANY_OS_LLM_API_KEY is required. Set it and retry — the OS does not guess.');
	}
	const model = env.COMPANY_OS_LLM_MODEL;
	if (!model) {
		throw new Error('COMPANY_OS_LLM_MODEL is required (e.g. gpt-4.1). Set it and retry — the OS does not guess.');
	}
	return { baseUrl, apiKey, model };
}

export type StreamEvent =
	| { type: 'text_delta'; text: string }
	| { type: 'tool_calls'; toolCalls: ToolCall[] }
	| { type: 'finish'; finishReason: string | null };

export interface ChatParams {
	messages: ChatMessage[];
	tools?: ApiTool[];
	temperature?: number;
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

interface StreamChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
}

export class LlmClient {
	constructor(
		private readonly config: LlmConfig,
		private readonly transport: Transport = fetch
	) {}

	get model(): string {
		return this.config.model;
	}

	/** Stream one assistant turn. Yields text deltas, assembled tool calls, then finish. */
	async *stream(params: ChatParams): AsyncGenerator<StreamEvent> {
		const url = `${this.config.baseUrl}/chat/completions`;
		const body: Record<string, unknown> = {
			model: this.config.model,
			messages: params.messages,
			stream: true
		};
		if (params.tools && params.tools.length > 0) body.tools = params.tools;
		if (params.temperature !== undefined) body.temperature = params.temperature;

		let response: Response;
		try {
			response = await this.transport(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${this.config.apiKey}`
				},
				body: JSON.stringify(body)
			});
		} catch (cause) {
			throw new Error(`LLM request to ${url} failed: ${(cause as Error).message}`);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(
				`LLM request failed: HTTP ${response.status} from ${url}${text ? ` — ${text.slice(0, 500)}` : ''}`
			);
		}
		if (!response.body) {
			throw new Error(`LLM response from ${url} has no body — cannot stream.`);
		}

		// tool-call deltas arrive spread across chunks, assembled by index
		const toolAccumulator = new Map<number, { id: string; name: string; arguments: string }>();
		let finishReason: string | null = null;

		for await (const data of sseData(response.body)) {
			if (data === '[DONE]') break;
			let chunk: StreamChunk;
			try {
				chunk = JSON.parse(data) as StreamChunk;
			} catch (cause) {
				throw new Error(`LLM stream sent invalid JSON: ${data.slice(0, 200)} (${(cause as Error).message})`);
			}
			const choice = chunk.choices?.[0];
			if (!choice) continue;
			const delta = choice.delta ?? {};
			if (typeof delta.content === 'string' && delta.content.length > 0) {
				yield { type: 'text_delta', text: delta.content };
			}
			if (Array.isArray(delta.tool_calls)) {
				for (const tc of delta.tool_calls) {
					const idx = tc.index ?? 0;
					const acc = toolAccumulator.get(idx) ?? { id: '', name: '', arguments: '' };
					if (tc.id) acc.id = tc.id;
					if (tc.function?.name) acc.name = tc.function.name;
					if (typeof tc.function?.arguments === 'string') acc.arguments += tc.function.arguments;
					toolAccumulator.set(idx, acc);
				}
			}
			if (choice.finish_reason) finishReason = choice.finish_reason;
		}

		if (toolAccumulator.size > 0) {
			const toolCalls = [...toolAccumulator.entries()]
				.sort(([a], [b]) => a - b)
				.map(([idx, acc]) => {
					if (!acc.id) throw new Error(`LLM stream produced tool call at index ${idx} without an id.`);
					if (!acc.name) throw new Error(`LLM stream produced tool call at index ${idx} without a name.`);
					return {
						id: acc.id,
						type: 'function' as const,
						function: { name: acc.name, arguments: acc.arguments }
					};
				});
			yield { type: 'tool_calls', toolCalls };
		}
		yield { type: 'finish', finishReason };
	}
}

/** Yield `data:` payload lines from an SSE stream. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, idx).replace(/\r$/, '');
			buffer = buffer.slice(idx + 1);
			if (line.startsWith('data:')) yield line.slice(5).trim();
		}
	}
	const rest = (buffer + decoder.decode()).trim();
	if (rest.startsWith('data:')) yield rest.slice(5).trim();
}
