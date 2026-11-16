import { describe, expect, it } from 'vitest'
import { isDark, markOf, toneOf } from './module-tone'

describe('module-tone: stages stay neutral, the mark carries the website part colour', () => {
  it('gives each part the colour it wears on the website', () => {
    expect(markOf('website')).toBe('blue')
    expect(markOf('email')).toBe('ice')
    expect(markOf('messages')).toBe('ink')
    expect(markOf('calls')).toBe('green')
    expect(markOf('calendar')).toBe('green')
    expect(markOf('memory')).toBe('violet')
    expect(markOf('drive')).toBe('grey')
    expect(markOf('brand')).toBe('yellow')
    expect(markOf('members')).toBe('peach')
    expect(markOf('contacts')).toBe('peach')
    expect(markOf('assistant')).toBe('yellow')
  })

  it('leaves a part without a colour neutral: ink on a light stage, white on a dark one', () => {
    expect(markOf('some-new-module')).toBe('ink')
    expect(markOf('some-new-module', true)).toBe('white')
  })

  it('keeps the stages neutral (no part sits on a colour tile)', () => {
    for (const id of ['website', 'memory', 'messages', 'calls', 'email', 'brand', 'drive', 'members', 'x']) {
      expect(['ink', 'charcoal', 'stone', 'white']).toContain(toneOf(id))
    }
    expect(isDark(toneOf('website'))).toBe(true)
    expect(isDark(toneOf('drive'))).toBe(false)
  })
})
