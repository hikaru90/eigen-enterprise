import { describe, expect, it } from 'vitest';
import { ToolError, ToolRegistry } from './tools.ts';
import type { ToolContext, ToolDef } from './tools.ts';

const ctx: ToolContext = {};

describe('ToolRegistry', () => {
	const def: ToolDef = {
		name: 'save_answer',
		description: 'Saves one founder answer',
		parameters: { type: 'object', properties: { text: { type: 'string' } } },
		execute: (args) => ({ saved: args })
	};

	it('registers a tool and exposes its API schema', () => {
		const registry = new ToolRegistry();
		registry.register(def);
		expect(registry.has('save_answer')).toBe(true);
		expect(registry.toApiTools()).toEqual([
			{
				type: 'function',
				function: {
					name: 'save_answer',
					description: 'Saves one founder answer',
					parameters: { type: 'object', properties: { text: { type: 'string' } } }
				}
			}
		]);
	});

	it('rejects duplicate names, missing descriptions, non-object schemas', () => {
		const registry = new ToolRegistry();
		registry.register(def);
		expect(() => registry.register(def)).toThrowError(/already registered/);
		expect(() =>
			registry.register({ ...def, name: 'no_desc', description: '', execute: () => 1 })
		).toThrowError(/description/);
		expect(() =>
			registry.register({
				...def,
				name: 'bad_schema',
				parameters: { type: 'string' },
				execute: () => 1
			})
		).toThrowError(/type "object"/);
	});

	it('executes with parsed arguments', async () => {
		const registry = new ToolRegistry();
		registry.register(def);
		const result = await registry.execute(
			{ id: '1', type: 'function', function: { name: 'save_answer', arguments: '{"text":"Kindred Digital Labs"}' } },
			ctx
		);
		expect(result).toEqual({ saved: { text: 'Kindred Digital Labs' } });
	});

	it('fails loud on unknown tools, listing what IS registered', async () => {
		const registry = new ToolRegistry();
		registry.register(def);
		await expect(
			registry.execute({ id: '1', type: 'function', function: { name: 'nope', arguments: '{}' } }, ctx)
		).rejects.toThrowError(/Unknown tool "nope" — registered: save_answer/);
		await expect(
			new ToolRegistry().execute({ id: '1', type: 'function', function: { name: 'nope', arguments: '{}' } }, ctx)
		).rejects.toThrowError(/registered: \(none\)/);
	});

	it('fails loud on invalid JSON arguments', async () => {
		const registry = new ToolRegistry();
		registry.register(def);
		const err = await registry
			.execute({ id: '1', type: 'function', function: { name: 'save_answer', arguments: '{broken' } }, ctx)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ToolError);
		expect((err as Error).message).toMatch(/invalid JSON arguments/);
	});
});
