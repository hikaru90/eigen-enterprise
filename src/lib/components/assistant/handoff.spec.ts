import { describe, expect, it } from 'vitest'
import { HANDOFF_PENDING_KEY, markHandoffPending, takePendingHandoff } from './handoff'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}
const broken = () => {
  throw new Error('SecurityError: storage blocked')
}

describe('onboarding hand-off mark', () => {
  it('is taken exactly once', () => {
    const store = memoryStorage()
    expect(takePendingHandoff(() => store)).toBe(false)
    markHandoffPending(() => store)
    expect(store.data.get(HANDOFF_PENDING_KEY)).toBe('1')
    expect(takePendingHandoff(() => store)).toBe(true)
    expect(takePendingHandoff(() => store)).toBe(false)
  })

  it('survives without storage through the in-memory flag', () => {
    markHandoffPending(broken)
    expect(takePendingHandoff(broken)).toBe(true)
    expect(takePendingHandoff(broken)).toBe(false)
  })
})
