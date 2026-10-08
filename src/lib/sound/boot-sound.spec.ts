import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSoundEnabled, setSoundEnabled } from './boot-sound'

/**
 * Runs in the node unit suite: the module guards on `window`, so a minimal
 * window/localStorage stub exercises the flag logic. The AudioContext paths
 * are browser-only and covered indirectly by the component/e2e specs.
 */
function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  }
}

const g = globalThis as { window?: { localStorage?: unknown } }

describe('boot-sound mute flag', () => {
  let storage: ReturnType<typeof makeLocalStorage>
  beforeEach(() => {
    storage = makeLocalStorage()
    g.window = { localStorage: storage }
  })
  afterEach(() => {
    delete g.window
    vi.restoreAllMocks()
  })

  it('is on by default — the owner ruled sound ships enabled', () => {
    expect(isSoundEnabled()).toBe(true)
  })

  it('persists the off decision and back on again', () => {
    setSoundEnabled(false)
    expect(storage.getItem('ee-sound')).toBe('off')
    expect(isSoundEnabled()).toBe(false)

    setSoundEnabled(true)
    expect(storage.getItem('ee-sound')).toBeNull()
    expect(isSoundEnabled()).toBe(true)
  })

  it('without a window there is no sound — no crash', () => {
    delete g.window
    expect(isSoundEnabled()).toBe(false)
    expect(() => setSoundEnabled(false)).not.toThrow()
  })
})
