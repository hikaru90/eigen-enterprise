import { describe, expect, it } from 'vitest'
import { applyTyping, typingLine, typistsIn } from './typing'

describe('typing in the page (Contribute 14aea69d)', () => {
  it('a frame replaces who writes in its conversation; an empty one clears it', () => {
    let m = applyTyping({}, { conversationId: 'c', typists: [{ userId: 'ada', threadRootId: null }] })
    expect(typistsIn(m, 'c', null, 'bea')).toEqual(['ada'])
    m = applyTyping(m, { conversationId: 'c', typists: [] })
    expect(m).toEqual({})
  })

  it('the main view and a thread are separate places, and I never see myself', () => {
    const m = applyTyping({}, {
      conversationId: 'c',
      typists: [
        { userId: 'ada', threadRootId: 'root' },
        { userId: 'bea', threadRootId: null },
      ],
    })
    expect(typistsIn(m, 'c', null, 'bea')).toEqual([])
    expect(typistsIn(m, 'c', 'root', 'bea')).toEqual(['ada'])
  })

  it('says it in words', () => {
    expect(typingLine([])).toBe('')
    expect(typingLine(['Ada'])).toBe('Ada is typing…')
    expect(typingLine(['Ada', 'Max'])).toBe('Ada and Max are typing…')
    expect(typingLine(['Ada', 'Max', 'Kim'])).toBe('Ada, Max and 1 other are typing…')
  })
})
