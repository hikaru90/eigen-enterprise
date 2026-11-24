import { describe, expect, it } from 'vitest'
import { TypingBoard } from '../../../../modules/messages/typing'
import { coworkerPresencePort } from './presence'
import type { CoworkerView } from './service'

const view = (id: string, extra: Partial<CoworkerView>) => ({ id, enabled: true, removedAt: null, ...extra }) as CoworkerView

describe('coworkerPresencePort (Contribute 14aea69d)', () => {
  it('on = available, writing = busy, off = paused; removed has no status', async () => {
    const board = new TypingBoard()
    const port = coworkerPresencePort({
      list: async () => [view('ada', {}), view('max', { enabled: false }), view('gone', { enabled: false, removedAt: '2026-11-01T00:00:00Z' })],
      board,
      onCoworkersChanged: () => () => {},
    })
    expect(await port.statuses()).toEqual(
      new Map([
        ['ada', 'available'],
        ['max', 'paused'],
      ]),
    )
    let told = 0
    const unsubscribe = port.subscribe(() => told++)
    const stop = board.start({ conversationId: 'c', threadRootId: null, userId: 'ada' })
    expect((await port.statuses()).get('ada')).toBe('busy')
    stop()
    expect(told).toBe(2)
    unsubscribe()
    board.start({ conversationId: 'c', threadRootId: null, userId: 'ada' })
    expect(told).toBe(2)
  })
})
