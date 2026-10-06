/**
 * Terminal rendering of loop events — pure so the CLI glue stays thin and the
 * behavior is testable. Named progress lines, never bare spinners
 * (first-conversation.md design rule 2).
 */

import type { LoopEvent } from '../lib/server/loop.ts';

/** One tool call → zero or more printable progress lines. */
export function renderEvent(event: LoopEvent, prev: LoopEvent | null): string[] {
	if (event.type === 'text_delta') return [event.text];
	if (event.type === 'tool_call') {
		if (event.call.function.name === 'ask_question') return ['\n'];
		return [`\n→ ${event.call.function.name}`];
	}
	if (event.type === 'tool_result') {
		const name = event.call.function.name;
		if (name === 'ask_question' && !event.isError) {
			try {
				const { asked } = JSON.parse(event.result);
				return [`${asked}\n`];
			} catch {
				return [];
			}
		}
		if (name === 'offer_choices' && !event.isError) {
			try {
				const { asked, choices } = JSON.parse(event.result);
				return [`${asked}\n  1) ${choices[0]}\n  2) ${choices[1]}\n`];
			} catch {
				return [];
			}
		}
		if (event.isError) return [`✗ ${name}: ${event.result.slice(0, 200)}`];
		return [`✓ ${name}`];
	}
	if (event.type === 'assistant_message') return [];
	if (event.type === 'finish') {
		if (event.reason === 'awaiting_user') return ['\n> '];
		if (prev?.type !== 'text_delta') return ['\n> '];
		return ['\n> '];
	}
	return [];
}
