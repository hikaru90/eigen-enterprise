import { describe, expect, it } from 'vitest'
import { PANEL_SESSION_KEY, readPanelSession, writePanelSession } from './panel-session'

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  }
}

const throwing = () => {
  throw new Error('storage blocked')
}

describe('panel session (board de821eda: the panel survives a full page load in this tab)', () => {
  it('reads back what was written', () => {
    const storage = memoryStorage()
    writePanelSession(() => storage, { open: true, tab: 'history' })
    expect(readPanelSession(() => storage)).toEqual({ open: true, tab: 'history' })
    writePanelSession(() => storage, { open: false, tab: 'chat' })
    expect(readPanelSession(() => storage)).toEqual({ open: false, tab: 'chat' })
  })

  it('has nothing to restore when nothing (usable) is stored', () => {
    expect(readPanelSession(() => memoryStorage())).toBeNull()
    for (const raw of ['not json', '{"open":"yes","tab":"chat"}', '{"open":true,"tab":"elsewhere"}', 'null']) {
      expect(readPanelSession(() => memoryStorage({ [PANEL_SESSION_KEY]: raw }))).toBeNull()
    }
  })

  it('without storage (private mode, blocked site data) the panel just starts closed', () => {
    expect(readPanelSession(throwing)).toBeNull()
    expect(() => writePanelSession(throwing, { open: true, tab: 'chat' })).not.toThrow()
  })
})
