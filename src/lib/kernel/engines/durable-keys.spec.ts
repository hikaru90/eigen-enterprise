import { describe, expect, it } from 'vitest'
import { durableConversationKey, sessionIdOfConversationKey } from './durable'

/**
 * Conversation keys stay `<agentId>:<sessionId>` (plan/phase-ai-coworkers.md §5): a co-worker's
 * session id is `coworker:<coworkerId>:<conversationId>:<threadRootId>`, one durable
 * conversation per thread per co-worker. Agent ids hold no colon, so the key splits at its
 * first colon and no two (agent, session) pairs share a key.
 */
describe('durable conversation keys for many agents', () => {
  const session = (coworkerId: string, conversationId: string, threadRootId: string) =>
    `coworker:${coworkerId}:${conversationId}:${threadRootId}`

  it('a co-worker thread session round-trips through its key', () => {
    const sessionId = session('cw-1', 'conv-9', 'msg-3')
    const key = durableConversationKey('coworker-cw-1', sessionId)
    expect(key).toBe('coworker-cw-1:coworker:cw-1:conv-9:msg-3')
    expect(sessionIdOfConversationKey('coworker-cw-1', key)).toBe(sessionId)
  })

  it('one key per (agent, conversation, thread): no collisions across co-workers, threads or the brain', () => {
    const pairs: Array<[string, string]> = []
    for (const agent of ['orchestrator', 'coworker-cw-1', 'coworker-cw-2']) {
      for (const coworkerId of ['cw-1', 'cw-2']) {
        for (const conversationId of ['conv-1', 'conv-2']) {
          for (const root of ['root-1', 'root-2']) pairs.push([agent, session(coworkerId, conversationId, root)])
        }
      }
      pairs.push([agent, 'chat-uuid-1'])
    }
    const keys = pairs.map(([agent, sessionId]) => durableConversationKey(agent, sessionId))
    expect(new Set(keys).size).toBe(pairs.length)
    // Every key belongs to exactly the agent that made it.
    for (const [agent, sessionId] of pairs) {
      const key = durableConversationKey(agent, sessionId)
      expect(sessionIdOfConversationKey(agent, key)).toBe(sessionId)
    }
  })

  it('an agent id with a colon, or an empty part, is refused loud (it could alias another agent’s key)', () => {
    // 'coworker' + 'cw-1:conv:root' would equal 'coworker:cw-1' + 'conv:root'.
    expect(() => durableConversationKey('coworker:cw-1', 'conv:root')).toThrow(/agent id/)
    expect(() => durableConversationKey('', 's')).toThrow(/agent id/)
    expect(() => durableConversationKey('orchestrator', '')).toThrow(/session id/)
  })
})
