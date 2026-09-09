import { describe, expect, it } from 'vitest'
import { InMemoryAgentSessionLog, type AgentSessionEvent } from './session-log'

function event(overrides: Partial<AgentSessionEvent> = {}): AgentSessionEvent {
  return {
    sessionId: 'session-1',
    agentId: 'orchestrator',
    kind: 'user',
    payload: { text: 'hello' },
    ...overrides,
  }
}

describe('InMemoryAgentSessionLog', () => {
  it('appends events and lists them back in chronological order', async () => {
    const log = new InMemoryAgentSessionLog()

    await log.append(event({ payload: { text: 'one' } }))
    await log.append(event({ kind: 'assistant', payload: { text: 'reply one' } }))

    expect(await log.list('session-1')).toEqual([
      { sessionId: 'session-1', agentId: 'orchestrator', kind: 'user', payload: { text: 'one' } },
      {
        sessionId: 'session-1',
        agentId: 'orchestrator',
        kind: 'assistant',
        payload: { text: 'reply one' },
      },
    ])
  })

  it('lists only the requested session', async () => {
    const log = new InMemoryAgentSessionLog()

    await log.append(event({ payload: { text: 'for 1' } }))
    await log.append(event({ sessionId: 'session-2', payload: { text: 'for 2' } }))

    expect((await log.list('session-1')).map((e) => e.payload)).toEqual([{ text: 'for 1' }])
    expect(await log.list('unknown')).toEqual([])
  })

  it('a limit keeps the LAST n events in chronological order', async () => {
    const log = new InMemoryAgentSessionLog()

    for (let i = 0; i < 5; i++) {
      await log.append(event({ payload: { text: `msg ${i}` } }))
    }

    const last3 = await log.list('session-1', 3)
    expect(last3.map((e) => e.payload)).toEqual([
      { text: 'msg 2' },
      { text: 'msg 3' },
      { text: 'msg 4' },
    ])
  })

  it('returns copies, not live internal state', async () => {
    const log = new InMemoryAgentSessionLog()
    await log.append(event())

    const listed = await log.list('session-1')
    listed.pop()
    expect(await log.list('session-1')).toHaveLength(1)
  })
})
