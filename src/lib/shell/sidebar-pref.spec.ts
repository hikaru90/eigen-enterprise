import { describe, expect, it } from 'vitest'
import { SIDEBAR_COLLAPSED_KEY, isSidebarToggleKey, readSidebarCollapsed, writeSidebarCollapsed } from './sidebar-pref'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}
const broken = () => {
  throw new Error('SecurityError: storage blocked')
}

describe('sidebar preference (Contribute ff714496)', () => {
  it('is expanded until the viewer collapses it', () => {
    expect(readSidebarCollapsed(() => memoryStorage())).toBe(false)
  })

  it('remembers a collapse and an expand', () => {
    const storage = memoryStorage()
    writeSidebarCollapsed(() => storage, true)
    expect(storage.data.get(SIDEBAR_COLLAPSED_KEY)).toBe('1')
    expect(readSidebarCollapsed(() => storage)).toBe(true)
    writeSidebarCollapsed(() => storage, false)
    expect(readSidebarCollapsed(() => storage)).toBe(false)
  })

  it('only the stored "1" means collapsed', () => {
    expect(readSidebarCollapsed(() => memoryStorage({ [SIDEBAR_COLLAPSED_KEY]: 'yes' }))).toBe(false)
  })

  it('blocked storage reads as expanded and writes nothing, without throwing', () => {
    expect(readSidebarCollapsed(broken)).toBe(false)
    expect(() => writeSidebarCollapsed(broken, true)).not.toThrow()
  })

  it('⌘\\ and Ctrl+\\ toggle; plain \\ and other chords do not', () => {
    const key = (init: Partial<KeyboardEvent>) =>
      ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent
    expect(isSidebarToggleKey(key({ key: '\\', code: 'Backslash', metaKey: true }))).toBe(true)
    expect(isSidebarToggleKey(key({ key: '\\', code: 'Backslash', ctrlKey: true }))).toBe(true)
    // Layouts where the key under Backslash types something else still toggle.
    expect(isSidebarToggleKey(key({ key: '#', code: 'Backslash', metaKey: true }))).toBe(true)
    expect(isSidebarToggleKey(key({ key: '\\', code: 'Backslash' }))).toBe(false)
    expect(isSidebarToggleKey(key({ key: '\\', code: 'Backslash', metaKey: true, altKey: true }))).toBe(false)
    expect(isSidebarToggleKey(key({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(false)
  })
})
