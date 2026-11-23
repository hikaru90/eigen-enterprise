import { describe, expect, it } from 'vitest'
import { THEME_PREFERENCES, parseThemePreference, resolveDark } from './theme'

describe('theme preference', () => {
  it('offers exactly Light, Dark and System, in that order', () => {
    expect(THEME_PREFERENCES.map((p) => p.value)).toEqual(['light', 'dark', 'system'])
    expect(THEME_PREFERENCES.map((p) => p.label)).toEqual(['Light', 'Dark', 'System'])
  })

  it('reads a stored light or dark choice as itself', () => {
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('system')).toBe('system')
  })

  it('reads nothing stored as System, as the pre-paint script in app.html does', () => {
    expect(parseThemePreference(null)).toBe('system')
  })

  it('reads an unknown stored value as System, as the pre-paint script does', () => {
    expect(parseThemePreference('sepia')).toBe('system')
  })

  it('resolves light and dark regardless of the OS, and System by the OS', () => {
    expect(resolveDark('light', true)).toBe(false)
    expect(resolveDark('dark', false)).toBe(true)
    expect(resolveDark('system', true)).toBe(true)
    expect(resolveDark('system', false)).toBe(false)
  })
})
