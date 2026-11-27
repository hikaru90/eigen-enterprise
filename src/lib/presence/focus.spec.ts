import { describe, expect, it, vi } from 'vitest'
import { PresenceFocus } from './focus.svelte'

describe('PresenceFocus (the one item a page says it has open)', () => {
  it('starts with nothing open', () => {
    expect(new PresenceFocus(() => {}).item).toBeNull()
  })

  it('a new item is kept and told at once; the same item again is not', () => {
    const changed = vi.fn()
    const focus = new PresenceFocus(changed)
    focus.set({ kind: 'conversation', id: 'c1' })
    expect(focus.item).toEqual({ kind: 'conversation', id: 'c1' })
    expect(changed).toHaveBeenCalledTimes(1)
    focus.set({ kind: 'conversation', id: 'c1' })
    expect(changed).toHaveBeenCalledTimes(1)
    focus.set({ kind: 'drive_file', id: 'c1' })
    expect(changed).toHaveBeenCalledTimes(2)
    focus.set(null)
    expect(focus.item).toBeNull()
    expect(changed).toHaveBeenCalledTimes(3)
    focus.set(null)
    expect(changed).toHaveBeenCalledTimes(3)
  })
})
