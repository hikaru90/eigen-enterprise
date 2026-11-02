import { describe, expect, it } from 'vitest'
import type { KernelEvent } from '$lib/kernel/events'
import { recapTypeCounts, summarizeEvents } from './summarize'

function event(type: string, payload: unknown = {}, ts = '2026-09-09T06:00:00.000Z'): KernelEvent {
  return { id: `${type}-${Math.random()}`, ts, type, payload }
}

describe('summarizeEvents', () => {
  it('renders a quiet day when the window has no events and no pending approvals', () => {
    const summary = summarizeEvents([])
    expect(summary.headline).toMatch(/[Qq]uiet day/)
    expect(summary.lines).toEqual(['No kernel events in the window.'])
  })

  it('counts events per type in whitelist order', () => {
    const events = [
      event('tool.executed'),
      event('tool.executed'),
      event('tool.executed'),
      event('agent.replied'),
      event('gateway.telegram.message'),
      event('website.contact.captured'),
    ]
    const summary = summarizeEvents(events)
    expect(summary.headline).toContain('6 kernel events')
    expect(summary.lines).toEqual([
      '1 agent.replied',
      '3 tool.executed',
      '1 gateway.telegram.message',
      '1 website.contact.captured',
    ])
  })

  it('orders unknown event types after the whitelisted ones (alphabetical)', () => {
    const events = [
      event('zeta.custom'),
      event('alpha.custom'),
      event('tool.executed'),
    ]
    const summary = summarizeEvents(events)
    expect(summary.lines).toEqual(['1 tool.executed', '1 alpha.custom', '1 zeta.custom'])
  })

  it('extracts budget_exceeded agent ids (deduped, sorted)', () => {
    const events = [
      event('agent.budget_exceeded', { agentId: 'agent-b', sessionId: 's1', spendUsd: 5 }),
      event('agent.budget_exceeded', { agentId: 'agent-a' }),
      event('agent.budget_exceeded', { agentId: 'agent-a' }),
    ]
    const summary = summarizeEvents(events)
    expect(summary.lines[0]).toBe('Notable: spend cap exceeded by agents agent-a, agent-b.')
  })

  it('reports denied gateway attempts as a count only (no user/chat ids)', () => {
    const events = [
      event('gateway.telegram.denied', {
        platform: 'telegram',
        externalUserId: '99993',
        externalChatId: '99994',
      }),
      event('gateway.telegram.denied', {
        platform: 'telegram',
        externalUserId: '88881',
        externalChatId: '88882',
      }),
    ]
    const summary = summarizeEvents(events)
    const deniedLine = summary.lines.find((l) => l.includes('denied gateway'))
    expect(deniedLine).toBe('Notable: 2 denied gateway attempts.')
    expect(summary.lines.join('\n')).not.toContain('9999')
    expect(summary.lines.join('\n')).not.toContain('8888')
  })

  it('surfaces pending approvals from extras', () => {
    const summary = summarizeEvents([event('tool.executed')], { pendingApprovals: 2 })
    expect(summary.lines[0]).toBe('Notable: 2 approvals pending.')
    const single = summarizeEvents([], { pendingApprovals: 1 })
    expect(single.lines[0]).toBe('Notable: 1 approval pending.')
    expect(single.headline).not.toMatch(/quiet/i)
  })

  it('never leaks non-whitelisted payload content into the output', () => {
    const secret = 'SECRET-CONTENT-42'
    const events = [
      event('agent.replied', { replyLength: 999, sessionId: secret }),
      event('tool.executed', { tool: 'email.send_mail', error: secret, durationMs: 12 }),
      event('gateway.telegram.message', { chatId: secret, textLength: secret.length }),
      event('website.contact.captured', { contactId: secret, email: secret }),
    ]
    const summary = summarizeEvents(events)
    expect(summary.lines.join('\n')).not.toContain(secret)
    expect(summary.headline).not.toContain(secret)
  })

  it('is deterministic: same input, same output', () => {
    const events = [
      event('tool.executed', { tool: 'a' }),
      event('agent.budget_exceeded', { agentId: 'x' }),
      event('website.contact.captured', { contactId: 'c' }),
    ]
    expect(summarizeEvents(events)).toEqual(summarizeEvents(events))
  })

  it('handles malformed payloads without throwing', () => {
    const events = [
      event('agent.budget_exceeded', null),
      event('website.contact.captured', 'not-an-object'),
      event('tool.executed', ['array', 'payload']),
    ]
    const summary = summarizeEvents(events)
    expect(summary.lines).toEqual([
      '1 agent.budget_exceeded',
      '1 tool.executed',
      '1 website.contact.captured',
    ])
  })
})

describe('recapTypeCounts', () => {
  it('returns zeroed counts for every whitelisted type and counts matches', () => {
    const events = [
      event('tool.executed'),
      event('tool.executed'),
      event('gateway.telegram.denied'),
      event('some.other.event'),
    ]
    const counts = recapTypeCounts(events)
    expect(counts['tool.executed']).toBe(2)
    expect(counts['gateway.telegram.denied']).toBe(1)
    expect(counts['website.contact.captured']).toBe(0)
    expect(Object.keys(counts)).toHaveLength(8)
  })
})
