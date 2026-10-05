/**
 * The tool registry — the agent's "system calls" (company-os-architecture.md §6.3).
 * Tools are JSON-schema typed; bad registrations and bad arguments fail loud.
 */

import type { ApiTool, ToolCall } from './llm.ts';

/** Per-call context threaded through tool execution (identity, stores, …). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type ToolContext = {}

export type ToolDef<C extends ToolContext = ToolContext> = {
	name: string;
	description: string;
	/** JSON schema, type "object". */
	parameters: Record<string, unknown>;
	execute(args: unknown, ctx: C): Promise<unknown> | unknown;
}

export class ToolError extends Error {}

export class ToolRegistry<C extends ToolContext = ToolContext> {
	private readonly tools = new Map<string, ToolDef<C>>();

	register(def: ToolDef<C>): void {
		if (!def.name) throw new ToolError('Tool must have a name.');
		if (this.tools.has(def.name)) throw new ToolError(`Tool "${def.name}" is already registered.`);
		if (!def.description) {
			throw new ToolError(`Tool "${def.name}" must have a description — the LLM picks tools by it.`);
		}
		if (!def.parameters || def.parameters.type !== 'object') {
			throw new ToolError(`Tool "${def.name}" parameters must be a JSON schema of type "object".`);
		}
		this.tools.set(def.name, def);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	names(): string[] {
		return [...this.tools.keys()];
	}

	/** The schemas sent to the LLM with every turn. */
	toApiTools(): ApiTool[] {
		return [...this.tools.values()].map((t) => ({
			type: 'function',
			function: { name: t.name, description: t.description, parameters: t.parameters }
		}));
	}

	/** Execute one LLM tool call. Throws ToolError on unknown tool or unparseable arguments. */
	async execute(call: ToolCall, ctx: C): Promise<unknown> {
		const def = this.tools.get(call.function.name);
		if (!def) {
			throw new ToolError(
				`Unknown tool "${call.function.name}" — registered: ${this.names().join(', ') || '(none)'}.`
			);
		}
		let args: unknown;
		try {
			args = JSON.parse(call.function.arguments);
		} catch (cause) {
			throw new ToolError(
				`Tool "${call.function.name}" received invalid JSON arguments: ${(cause as Error).message}`
			);
		}
		return await def.execute(args, ctx);
	}
}
