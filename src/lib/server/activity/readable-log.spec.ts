import { describe, expect, it } from 'vitest'
import type { KernelEvent } from '$lib/kernel/events'
import { groupLogByDay, toLogEntry } from './readable-log'

const AGENTS = new Set(['orchestrator'])

function ev(overrides: Partial<KernelEvent>): KernelEvent {
  return {
    id: 'e1',
    ts: '2026-09-08T10:05:00.000Z',
    type: 'agent.dispatched',
    principalId: 'orchestrator',
    source: 'urn:eigenenterprise:kernel',
    payload: {},
    ...overrides,
  }
}

describe('toLogEntry', () => {
  it('says what the agent did in plain words, with the module and outcome', () => {
    const e = toLogEntry(
      ev({
        type: 'tool.executed',
        source: 'urn:eigenenterprise:module:website',
        payload: { tool: 'website.list_pages', auditClass: 'read', ok: true, durationMs: 12 },
      }),
      AGENTS,
    )
    expect(e).toMatchObject({
      id: 'e1',
      day: '2026-09-08',
      module: 'website',
      moduleLabel: 'Website',
      actor: 'Agent',
      text: 'Used Website: list pages',
      outcome: 'done',
    })
  })

  it("prefers the tool's own activity sentence and marks failures", () => {
    const e = toLogEntry(
      ev({
        type: 'tool.executed',
        source: 'urn:eigenenterprise:module:website',
        payload: { tool: 'website.publish', ok: false, activity: 'Published the home page' },
      }),
      AGENTS,
    )
    expect(e.text).toBe('Published the home page')
    expect(e.outcome).toBe('failed')
  })

  it('names people, not principal ids, and never leaks them or content fields', () => {
    const e = toLogEntry(
      ev({
        type: 'tool.executed',
        principalId: 'user-secret-id',
        source: 'urn:eigenenterprise:module:email',
        payload: { tool: 'email.send', ok: true, error: 'SECRET', body: 'SECRET' },
      }),
      AGENTS,
    )
    expect(e.actor).toBe('A team member')
    expect(JSON.stringify(e)).not.toContain('user-secret-id')
    expect(JSON.stringify(e)).not.toContain('SECRET')
  })

  it.each([
    ['agent.dispatched', 'Started working on a conversation', null],
    ['agent.replied', 'Replied in a conversation', 'done'],
    ['agent.stopped', 'Was stopped', null],
    ['agent.budget_exceeded', 'Hit its spending limit and did not run', 'failed'],
  ] as const)('%s -> %s', (type, text, outcome) => {
    const e = toLogEntry(ev({ type, payload: { agentId: 'orchestrator', spendUsd: 9 } }), AGENTS)
    expect(e).toMatchObject({ module: 'agent', actor: 'Agent', text, outcome })
    expect(JSON.stringify(e)).not.toContain('spendUsd')
  })

  it('reads chat-gateway events as Telegram', () => {
    const e = toLogEntry(
      ev({
        type: 'gateway.telegram.denied',
        principalId: undefined,
        source: 'urn:eigenenterprise:module:chat-gateway',
        payload: { externalUserId: 'x', externalChatId: 'y' },
      }),
      AGENTS,
    )
    expect(e).toMatchObject({
      actor: 'Telegram',
      module: 'chat-gateway',
      text: 'Refused a message from an unknown sender',
      outcome: 'failed',
    })
    expect(JSON.stringify(e)).not.toContain('externalChatId')
  })

  it('fails loud on an event type outside the whitelist', () => {
    expect(() => toLogEntry(ev({ type: 'weird.event' }), AGENTS)).toThrow(/weird.event/)
  })
})

describe('groupLogByDay', () => {
  it('keeps newest-first order and groups by UTC day', () => {
    const entries = [
      toLogEntry(ev({ id: 'a', ts: '2026-09-09T08:00:00.000Z' }), AGENTS),
      toLogEntry(ev({ id: 'b', ts: '2026-09-08T23:00:00.000Z' }), AGENTS),
      toLogEntry(ev({ id: 'c', ts: '2026-09-08T01:00:00.000Z' }), AGENTS),
    ]
    const days = groupLogByDay(entries)
    expect(days.map((d) => [d.day, d.entries.map((e) => e.id)])).toEqual([
      ['2026-09-09', ['a']],
      ['2026-09-08', ['b', 'c']],
    ])
  })
})
