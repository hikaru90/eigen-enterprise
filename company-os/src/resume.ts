/**
 * Resume support — first-conversation §5: re-entry says
 * "You were setting up <company> — where were we?" Nothing is lost, ever.
 * This is data assembly only; the phrasing belongs to the conversation policy (M2).
 */

import type { MemoryStore } from './memory.ts';
import type { SessionRecord, SessionStore } from './session.ts';

export type ResumeContext = {
	session: SessionRecord;
	companyName: string | null;
}

/** Returns the open session to resume, or null for a fresh start. */
export async function resumeContext(
	sessions: SessionStore,
	memory: MemoryStore
): Promise<ResumeContext | null> {
	const open = await sessions.latestOpen();
	if (!open || open.messages.length === 0) return null;
	const entries = await memory.latest();
	const name = entries.find((e) => e.kind === 'answer' && e.key === 'company.name');
	return { session: open, companyName: name ? name.value : null };
}
