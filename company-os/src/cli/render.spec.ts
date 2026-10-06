import { describe, expect, it } from 'vitest';
import { renderEvent } from './render.ts';
import type { LoopEvent } from '../lib/server/loop.ts';

const toolCallEv = (name: string, args: string): LoopEvent => ({
	type: 'tool_call',
	call: { id: 'c1', type: 'function', function: { name, arguments: args } }
});

const toolResultEv = (name: string, result: string, isError = false): LoopEvent => ({
	type: 'tool_result',
	call: { id: 'c1', type: 'function', function: { name, arguments: '{}' } },
	result,
	isError
});

describe('renderEvent', () => {
	it('streams text deltas verbatim', () => {
		expect(renderEvent({ type: 'text_delta', text: 'Hello' }, null)).toEqual(['Hello']);
	});

	it('shows named progress lines for tools, questions delivered prominently', () => {
		expect(renderEvent(toolCallEv('save_answer', '{}'), null)).toEqual(['\n→ save_answer']);
		expect(renderEvent(toolResultEv('save_answer', '{"saved":{}}'), null)).toEqual(['✓ save_answer']);

		const lines = renderEvent(
			toolResultEv('ask_question', JSON.stringify({ asked: 'What is your company called?', turn_ends: true })),
			toolCallEv('ask_question', '{}')
		);
		expect(lines.join('')).toContain('What is your company called?');
	});

	it('renders choices as a numbered pair', () => {
		const lines = renderEvent(
			toolResultEv(
				'offer_choices',
				JSON.stringify({ asked: 'Book or buy?', choices: ['book a shoot', 'order prints'], turn_ends: true })
			),
			null
		);
		expect(lines.join('')).toContain('1) book a shoot');
		expect(lines.join('')).toContain('2) order prints');
	});

	it('surfaces tool errors honestly', () => {
		const lines = renderEvent(toolResultEv('save_answer', 'ERROR: never invent content', true), null);
		expect(lines.join('')).toContain('✗ save_answer');
		expect(lines.join('')).toContain('never invent');
	});

	it('ends the turn with a founder prompt on halt', () => {
		const lines = renderEvent({ type: 'finish', reason: 'awaiting_user', messages: [] }, null);
		expect(lines.join('')).toContain('> ');
	});
});
