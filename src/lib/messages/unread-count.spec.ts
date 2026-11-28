import { describe, expect, it } from 'vitest'
import { applyUnreadFrame, unreadTotal } from './unread-count.svelte'

describe('the sidebar Messages counter (wish f397009a)', () => {
  it('sums each conversation and follows message, conversation and read frames', () => {
    let m: Record<string, number> = { a: 2, b: 0 }
    expect(unreadTotal(m)).toBe(2)
    m = applyUnreadFrame(m, 'message', { message: { conversationId: 'b' }, unread: 3 })
    expect(unreadTotal(m)).toBe(5)
    m = applyUnreadFrame(m, 'read', { conversationId: 'a', unread: 0 })
    expect(unreadTotal(m)).toBe(3)
    m = applyUnreadFrame(m, 'conversation', { conversation: { id: 'c', unread: 1 } })
    expect(unreadTotal(m)).toBe(4)
    expect(applyUnreadFrame(m, 'presence', { people: [] })).toBe(m)
  })
})
