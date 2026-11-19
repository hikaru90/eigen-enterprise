import { describe, expect, it } from 'vitest'
import { createDrafts, draftKey, type DraftStorage } from './drafts'

function memoryStorage(): DraftStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
  }
}

describe('message drafts (kept in this browser, per user and conversation)', () => {
  it('a draft written for a conversation is read back when it opens again', () => {
    const store = memoryStorage()
    createDrafts('u1', () => store).write('c1', 'Hallo\n\nhalb fertig')
    expect(createDrafts('u1', () => store).read('c1')).toBe('Hallo\n\nhalb fertig')
  })

  it('each conversation keeps its own draft; a conversation without one starts empty', () => {
    const store = memoryStorage()
    const drafts = createDrafts('u1', () => store)
    drafts.write('c1', 'for one')
    expect(drafts.read('c2')).toBe('')
    drafts.write('c2', 'for two')
    expect(drafts.read('c1')).toBe('for one')
    expect(drafts.read('c2')).toBe('for two')
  })

  it('drafts are per user: someone else signed in on this browser does not see mine', () => {
    const store = memoryStorage()
    createDrafts('u1', () => store).write('c1', 'mine')
    expect(createDrafts('u2', () => store).read('c1')).toBe('')
    expect(draftKey('u1', 'c1')).not.toBe(draftKey('u2', 'c1'))
  })

  it('clearing (after sending) removes it; an emptied box leaves nothing stored', () => {
    const store = memoryStorage()
    const drafts = createDrafts('u1', () => store)
    drafts.write('c1', 'sent soon')
    drafts.clear('c1')
    expect(drafts.read('c1')).toBe('')
    drafts.write('c2', 'typed')
    drafts.write('c2', '  \n')
    expect(store.items.size).toBe(0)
  })

  it('no storage, or storage that refuses, never breaks the composer: no draft is kept', () => {
    const missing = createDrafts('u1', () => {
      throw new Error('SecurityError: localStorage is not available')
    })
    expect(() => missing.write('c1', 'x')).not.toThrow()
    expect(() => missing.clear('c1')).not.toThrow()
    expect(missing.read('c1')).toBe('')
    // Within the open page each conversation still keeps its own draft.
    missing.write('c1', 'one')
    missing.write('c2', 'two')
    expect(missing.read('c1')).toBe('one')
    expect(missing.read('c2')).toBe('two')
    expect(createDrafts('u1', () => memoryStorage()).read('c1')).toBe('')

    const refusing = createDrafts('u1', () => ({
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }))
    expect(() => refusing.write('c1', 'x')).not.toThrow()
    expect(refusing.read('c1')).toBe('x')
    expect(() => refusing.clear('c1')).not.toThrow()
    expect(refusing.read('c1')).toBe('')
  })
})
