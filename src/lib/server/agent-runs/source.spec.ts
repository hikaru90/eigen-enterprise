import { describe, expect, it, vi } from 'vitest'
import { InMemoryDurableConversationIndex } from '$lib/server/agent/conversation-index'
import { createAgentRunsSource } from './source'
import { fakeEventStream } from './test-fixtures'

async function seeded() {
  const index = new InMemoryDurableConversationIndex()
  await index.recordConversation({
    conversationKey: 'orchestrator:a',
    agentId: 'orchestrator',
    task: 'assistant.turn',
    llmUserId: 'user-a',
    piConversationId: '41',
    providerSessionId: 'prov-secret-a',
  })
  await index.recordConversation({
    conversationKey: 'orchestrator:b',
    agentId: 'orchestrator',
    task: 'assistant.turn',
    llmUserId: 'user-b',
    piConversationId: '42',
    providerSessionId: 'prov-secret-b',
  })
  return index
}

describe('createAgentRunsSource', () => {
  it('lists conversations newest-updated first, metadata only (no attribution keys)', async () => {
    const index = await seeded()
    await new Promise((r) => setTimeout(r, 5))
    await index.touch(1)
    const source = createAgentRunsSource({
      index,
      harness: vi.fn(),
      memberNames: async () => new Map([['user-a', 'Ada Park']]),
    })
    const runs = await source.list('viewer')
    expect(runs.map((r) => r.id)).toEqual([1, 2])
    expect(Object.keys(runs[0]).sort()).toEqual([
      'agentId',
      'conversationKey',
      'createdAt',
      'id',
      'renamable',
      'title',
      'updatedAt',
    ])
    // Readable titles: the member's name, never their id.
    expect(runs.map((r) => r.title)).toEqual(['Chat with Ada Park', 'Chat with a team member'])
    expect(JSON.stringify(runs)).not.toMatch(/prov-secret|user-a|user-b/)
    expect(typeof runs[0].createdAt).toBe('string')
  })

  it('titles a chat after its first message when there is one', async () => {
    const index = await seeded()
    const chatTopics = vi.fn(async () => new Map([['b', 'Build me a bakery site']]))
    const source = createAgentRunsSource({
      index,
      harness: vi.fn(),
      memberNames: async () => new Map([['user-a', 'Ada Park']]),
      chatTopics,
    })
    const runs = await source.list('viewer')
    // The chat session id is the key's part after `<agentId>:`.
    expect(chatTopics).toHaveBeenCalledWith(expect.arrayContaining(['a', 'b']))
    expect(Object.fromEntries(runs.map((r) => [r.conversationKey, r.title]))).toEqual({
      'orchestrator:a': 'Chat with Ada Park',
      'orchestrator:b': 'Build me a bakery site',
    })
  })

  it('watches a run through the harness box with its pi conversation id', async () => {
    const index = await seeded()
    const fake = fakeEventStream()
    const events = vi.fn(async () => fake.stream)
    const source = createAgentRunsSource({ index, harness: async () => ({ events }) })
    expect(await source.watch(2)).toBe(fake.stream)
    expect(events).toHaveBeenCalledWith(42)
  })

  it('returns null for an unknown run without opening the harness', async () => {
    const index = await seeded()
    const harness = vi.fn()
    const source = createAgentRunsSource({ index, harness })
    expect(await source.watch(99)).toBeNull()
    expect(harness).not.toHaveBeenCalled()
  })
  it('marks only the viewer\'s own conversations renamable', async () => {
    const index = await seeded()
    const source = createAgentRunsSource({ index, harness: vi.fn() })
    const runs = await source.list('user-b')
    expect(Object.fromEntries(runs.map((r) => [r.id, r.renamable]))).toEqual({ 1: false, 2: true })
  })

  it('renames the owner\'s conversation; the name wins over every derived title', async () => {
    const index = await seeded()
    const chatTopics = vi.fn(async () => new Map([['b', 'Build me a bakery site']]))
    const source = createAgentRunsSource({ index, harness: vi.fn(), chatTopics })
    const before = (await index.listConversations()).find((r) => r.id === 2)!.updatedAt
    const result = await source.rename('user-b', 2, 'Bakery website')
    expect(result).toMatchObject({ ok: true, run: { id: 2, title: 'Bakery website', renamable: true } })
    // Renaming is not activity: the list order (updated_at) stays.
    expect((await index.listConversations()).find((r) => r.id === 2)!.updatedAt).toEqual(before)
    // Read-time auto titles (first message) never replace a member's name.
    const runs = await source.list('user-a')
    expect(runs.find((r) => r.id === 2)!.title).toBe('Bakery website')
  })

  it('refuses to rename another member\'s conversation and leaves it as it was', async () => {
    const index = await seeded()
    const source = createAgentRunsSource({ index, harness: vi.fn() })
    expect(await source.rename('user-a', 2, 'Hijacked')).toEqual({
      ok: false,
      status: 403,
      error: 'Only the member who had this conversation can rename it.',
    })
    expect((await index.listConversations()).find((r) => r.id === 2)!.userTitle).toBeNull()
  })

  it('reports an unknown conversation as 404', async () => {
    const index = await seeded()
    const source = createAgentRunsSource({ index, harness: vi.fn() })
    expect(await source.rename('user-a', 99, 'x')).toEqual({
      ok: false,
      status: 404,
      error: 'unknown run 99',
    })
  })
})
