import type { AllowlistReader } from './types'
import { describe, expect, it } from 'vitest'
import { InMemoryEventSink } from '$lib/kernel/events'
import type { KernelEvent } from '$lib/kernel/events'
import type { AppDatabase } from '$lib/server/db/context'
import { chunkRecapText, deliverRecap, formatRecapText, RECAP_MESSAGE_MAX_LEN } from './deliver'
import { summarizeEvents } from './summarize'

function fakeDb(sessions: unknown[]): AppDatabase {
  const builder = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(sessions).then(resolve),
  }
  return { select: () => builder } as unknown as AppDatabase
}

function fakeSender() {
  const sends: Array<{ chatId: string; text: string }> = []
  return {
    sends,
    sendMessage: async (chatId: string, text: string) => {
      sends.push({ chatId, text })
    },
  }
}

const allowlist: AllowlistReader = {
  list: async () => [{ platform: 'telegram', externalUserId: 'u1', principalId: 'p-owner' }],
}

function event(type: string, payload: unknown = {}): KernelEvent {
  return { id: `${type}-1`, ts: '2026-09-09T06:00:00.000Z', type, payload }
}

const window = {
  start: new Date('2026-09-08T07:00:00.000Z'),
  end: new Date('2026-09-09T07:00:00.000Z'),
}

describe('formatRecapText / chunkRecapText', () => {
  it('formats headline, window, and lines as plain text', () => {
    const summary = summarizeEvents([event('tool.executed')])
    const text = formatRecapText(summary, window)
    expect(text).toContain(summary.headline)
    expect(text).toContain('Window: 2026-09-08T07:00:00.000Z → 2026-09-09T07:00:00.000Z')
    expect(text).toContain('1 tool.executed')
  })

  it('chunks by paragraph without exceeding the telegram-safe length', () => {
    const paragraphs = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(50)}`)
    const text = paragraphs.join('\n\n')
    const chunks = chunkRecapText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(RECAP_MESSAGE_MAX_LEN)
      expect(chunk.length).toBeGreaterThan(0)
    }
    expect(chunks.join('\n\n')).toBe(text)
  })

  it('hard-wraps a single oversized paragraph and preserves every character', () => {
    const text = 'y'.repeat(RECAP_MESSAGE_MAX_LEN + 500)
    const chunks = chunkRecapText(text)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(RECAP_MESSAGE_MAX_LEN)
    expect(chunks.join('')).toBe(text)
  })

  it('throws loud on an invalid maxLen and returns no chunks for empty text', () => {
    expect(() => chunkRecapText('x', 0)).toThrow(RangeError)
    expect(chunkRecapText('   ')).toEqual([])
  })
})

describe('deliverRecap', () => {
  it('sends one chunked message per owner chat and emits recap.completed (metadata only)', async () => {
    const sender = fakeSender()
    const sink = new InMemoryEventSink()
    const db = fakeDb([
      { externalChatId: '200', principalId: 'p-owner' },
      { externalChatId: '100', principalId: 'p-owner' },
    ])
    const events = [
      event('tool.executed', { tool: 'email.send_mail' }),
      event('agent.budget_exceeded', { agentId: 'agent-1' }),
    ]
    const summary = summarizeEvents(events, { pendingApprovals: 1 })

    const result = await deliverRecap(
      { db, telegram: sender, allowlist, eventSink: sink },
      { summary, window, events },
    )

    // two chats, single chunk each
    expect(result.deliveredChats).toEqual(['100', '200'])
    expect(result.chunkCount).toBe(2)
    expect(sender.sends).toHaveLength(2)
    expect(sender.sends[0].chatId).toBe('100')
    expect(sender.sends[0].text).toContain('1 tool.executed')

    expect(sink.events).toHaveLength(1)
    const emitted = sink.events[0]
    expect(emitted.type).toBe('recap.completed')
    expect(emitted.source).toBe('urn:eigenenterprise:module:recap')
    expect(emitted.payload).toEqual({
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      eventCount: 2,
      typeCounts: expect.objectContaining({ 'tool.executed': 1 }),
      deliveredChats: ['100', '200'],
      chunkCount: 2,
    })
  })

  it('never leaks event content or summary prose into the recap.completed payload', async () => {
    const secret = 'SECRET-CONTENT-99'
    const sender = fakeSender()
    const sink = new InMemoryEventSink()
    const db = fakeDb([{ externalChatId: '200', principalId: 'p-owner' }])
    const events = [event('gateway.telegram.message', { chatId: secret, textLength: 5 })]
    const summary = summarizeEvents(events)

    await deliverRecap({ db, telegram: sender, allowlist, eventSink: sink }, { summary, window, events })

    const payload = JSON.stringify(sink.events[0].payload)
    expect(payload).not.toContain(secret)
    expect(payload).not.toContain('tool.executed line')
  })

  it('completes with zero sends (event still emitted) when no owner chat exists', async () => {
    const sender = fakeSender()
    const sink = new InMemoryEventSink()
    const db = fakeDb([])
    const events = [event('tool.executed')]

    const result = await deliverRecap(
      { db, telegram: sender, allowlist, eventSink: sink },
      { summary: summarizeEvents(events), window, events },
    )

    expect(result).toEqual({
      deliveredChats: [],
      chunkCount: 0,
      eventCount: 1,
    })
    expect(sender.sends).toHaveLength(0)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].payload).toMatchObject({ deliveredChats: [], chunkCount: 0 })
  })

  it('propagates send failures loud (no silent degradation)', async () => {
    const failingSender = {
      sendMessage: async () => {
        throw new Error('telegram sendMessage failed (502)')
      },
    }
    const db = fakeDb([{ externalChatId: '200', principalId: 'p-owner' }])
    const events = [event('tool.executed')]
    await expect(
      deliverRecap(
        { db, telegram: failingSender, allowlist, eventSink: new InMemoryEventSink() },
        { summary: summarizeEvents(events), window, events },
      ),
    ).rejects.toThrow(/telegram sendMessage failed/)
  })
})
