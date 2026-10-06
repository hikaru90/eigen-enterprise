import { describe, expect, it } from 'vitest';
import { InMemoryMemoryStore } from './memory.ts';
import { resumeContext } from './resume.ts';
import { InMemorySessionStore } from './session.ts';

describe('resumeContext', () => {
	it('returns null for a fresh start (no sessions)', async () => {
		const ctx = await resumeContext(new InMemorySessionStore(), new InMemoryMemoryStore());
		expect(ctx).toBeNull();
	});

	it('returns null for an open session that has no messages yet', async () => {
		const sessions = new InMemorySessionStore();
		await sessions.create();
		expect(await resumeContext(sessions, new InMemoryMemoryStore())).toBeNull();
	});

	it('resumes the open session with the remembered company name', async () => {
		const sessions = new InMemorySessionStore();
		const memory = new InMemoryMemoryStore();
		const session = await sessions.create();
		await sessions.append(session.id, [{ role: 'user', content: 'Ich habe eine Firma namens Hafenlicht' }]);
		await memory.remember({ kind: 'answer', key: 'company.name', value: 'Hafenlicht' });

		const ctx = await resumeContext(sessions, memory);
		expect(ctx?.session.id).toBe(session.id);
		expect(ctx?.companyName).toBe('Hafenlicht');
	});

	it('companyName is null when memory has no company.name yet', async () => {
		const sessions = new InMemorySessionStore();
		const session = await sessions.create();
		await sessions.append(session.id, [{ role: 'user', content: 'hello' }]);
		const ctx = await resumeContext(sessions, new InMemoryMemoryStore());
		expect(ctx?.session.id).toBe(session.id);
		expect(ctx?.companyName).toBeNull();
	});

	it('never resumes a completed session', async () => {
		const sessions = new InMemorySessionStore();
		const session = await sessions.create();
		await sessions.append(session.id, [{ role: 'user', content: 'done deal' }]);
		await sessions.markCompleted(session.id);
		expect(await resumeContext(sessions, new InMemoryMemoryStore())).toBeNull();
	});
});
