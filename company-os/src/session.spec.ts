import type { ChatMessage } from './llm.ts';
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from './session.ts';

const user = (text: string): ChatMessage => ({ role: 'user', content: text });

describe('InMemorySessionStore', () => {
	it('creates, appends, and returns messages in order', async () => {
		const store = new InMemorySessionStore();
		const session = await store.create();
		expect(session.status).toBe('open');
		expect(session.messages).toEqual([]);

		await store.append(session.id, [user('hi')]);
		await store.append(session.id, [{ role: 'assistant', content: 'hello' }]);
		const loaded = await store.get(session.id);
		expect(loaded?.messages.map((m) => m.content)).toEqual(['hi', 'hello']);
	});

	it('returns null for unknown sessions and throws on append to them', async () => {
		const store = new InMemorySessionStore();
		expect(await store.get('00000000-0000-0000-0000-000000000000')).toBeNull();
		await expect(store.append('nope', [user('x')])).rejects.toThrowError(/does not exist/);
	});

	it('latestOpen returns the most recently updated open session', async () => {
		const store = new InMemorySessionStore();
		const first = await store.create();
		await store.append(first.id, [user('first')]);
		const second = await store.create();
		await store.append(second.id, [user('second')]);

		expect((await store.latestOpen())?.id).toBe(second.id);
		await store.markCompleted(second.id);
		expect((await store.latestOpen())?.id).toBe(first.id);
	});

	it('never surfaces completed sessions, and completing twice is idempotent', async () => {
		const store = new InMemorySessionStore();
		const only = await store.create();
		await store.markCompleted(only.id);
		expect(await store.latestOpen()).toBeNull();
		await expect(store.markCompleted(only.id)).resolves.toBeUndefined();
	});

	it('snapshot isolation: appended arrays do not mutate what the caller held', async () => {
		const store = new InMemorySessionStore();
		const session = await store.create();
		const before = session.messages.length;
		await store.append(session.id, [user('x')]);
		expect(session.messages).toHaveLength(before);
	});
});
