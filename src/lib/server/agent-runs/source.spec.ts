import { describe, expect, it, vi } from 'vitest'
import { InMemoryDurableConversationIndex } from '$lib/server/agent/conversation-index'
import { createAgentRunsSource } from './source'
import { fakeEventStream } from './test-fixtures'

async function seeded() {
  const index = new InMemoryDurableConversationIndex()
  await index.recordConversation({
    conversationKey: 'orchestrator:a',
    agentId: 'orchestrator',
    llmUserId: 'user-a',
    piConversationId: '41',
    providerSessionId: 'prov-secret-a',
  })
  await index.recordConversation({
    conversationKey: 'orchestrator:b',
    agentId: 'orchestrator',
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
    const runs = await source.list()
    expect(runs.map((r) => r.id)).toEqual([1, 2])
    expect(Object.keys(runs[0]).sort()).toEqual([
      'agentId',
      'conversationKey',
      'createdAt',
      'id',
      'title',
      'updatedAt',
    ])
    // Readable titles: the member's name, never their id.
    expect(runs.map((r) => r.title)).toEqual(['Chat with Ada Park', 'Chat with a team member'])
    expect(JSON.stringify(runs)).not.toMatch(/prov-secret|user-a|user-b/)
    expect(typeof runs[0].createdAt).toBe('string')
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
})
