import { describe, expect, it } from 'vitest'
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH_KEY,
  clampPanelWidth,
  panelMaxWidth,
  readPanelWidth,
  writePanelWidth,
} from './panel-width'

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

describe('assistant panel width', () => {
  it('stays between the minimum and 60% of the window', () => {
    expect(clampPanelWidth(100, 1600)).toBe(PANEL_MIN_WIDTH)
    expect(clampPanelWidth(500, 1600)).toBe(500)
    expect(clampPanelWidth(2000, 1600)).toBe(960)
    expect(panelMaxWidth(1600)).toBe(960)
  })

  it('never goes below the minimum, even in a narrow window', () => {
    expect(panelMaxWidth(400)).toBe(PANEL_MIN_WIDTH)
    expect(clampPanelWidth(900, 400)).toBe(PANEL_MIN_WIDTH)
  })

  it('a width that is not a number opens at the default', () => {
    expect(clampPanelWidth(Number.NaN, 1600)).toBe(PANEL_DEFAULT_WIDTH)
  })

  it('remembers the width per browser', () => {
    const store = memoryStorage()
    expect(readPanelWidth(() => store)).toBeNull()
    writePanelWidth(() => store, 512.4)
    expect(store.data.get(PANEL_WIDTH_KEY)).toBe('512')
    expect(readPanelWidth(() => store)).toBe(512)
    expect(readPanelWidth(() => memoryStorage({ [PANEL_WIDTH_KEY]: 'wide' }))).toBeNull()
  })

  it('works without storage (private mode, blocked site data)', () => {
    expect(readPanelWidth(broken)).toBeNull()
    expect(() => writePanelWidth(broken, 400)).not.toThrow()
  })
})
