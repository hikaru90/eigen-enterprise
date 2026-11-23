import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import { startThemeSync } from './theme'
import ThemeSwitch from './theme-switch.svelte'

/** A controllable `(prefers-color-scheme: dark)`: the OS theme the test flips. */
function fakeSystemTheme(initiallyDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const list = {
    matches: initiallyDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.delete(fn),
  }
  const realMatchMedia = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
    query === '(prefers-color-scheme: dark)'
      ? (list as unknown as MediaQueryList)
      : realMatchMedia(query),
  )
  return {
    flip(dark: boolean) {
      list.matches = dark
      for (const fn of listeners) fn({ matches: dark } as MediaQueryListEvent)
    },
  }
}

const root = () => document.documentElement

describe('theme-switch.svelte', () => {
  let stopSync: (() => void) | null = null
  let meta: HTMLMetaElement

  beforeEach(() => {
    localStorage.removeItem('theme-preference')
    root().classList.remove('dark')
    root().style.colorScheme = ''
    meta = document.createElement('meta')
    meta.id = 'theme-color-meta'
    meta.name = 'theme-color'
    meta.content = 'stale'
    document.head.append(meta)
    root().style.setProperty('--theme-color', '#000000')
  })

  afterEach(() => {
    stopSync?.()
    stopSync = null
    meta.remove()
    root().style.removeProperty('--theme-color')
    root().classList.remove('dark')
    root().style.colorScheme = ''
    localStorage.removeItem('theme-preference')
    vi.restoreAllMocks()
  })

  it('offers Light, Dark and System, with System chosen when nothing is stored', async () => {
    fakeSystemTheme(false)
    render(ThemeSwitch)

    const group = page.getByRole('radiogroup', { name: 'Theme' })
    await expect.element(group).toBeInTheDocument()
    await expect
      .element(page.getByRole('radio', { name: 'Light' }))
      .toHaveAttribute('aria-checked', 'false')
    await expect
      .element(page.getByRole('radio', { name: 'Dark' }))
      .toHaveAttribute('aria-checked', 'false')
    await expect
      .element(page.getByRole('radio', { name: 'System' }))
      .toHaveAttribute('aria-checked', 'true')
  })

  it('shows the stored choice', async () => {
    fakeSystemTheme(false)
    localStorage.setItem('theme-preference', 'dark')
    render(ThemeSwitch)

    await expect
      .element(page.getByRole('radio', { name: 'Dark' }))
      .toHaveAttribute('aria-checked', 'true')
  })

  it('choosing Dark applies it at once: dark class, color-scheme, theme-color, stored on this device', async () => {
    fakeSystemTheme(false)
    stopSync = startThemeSync()
    render(ThemeSwitch)

    await page.getByRole('radio', { name: 'Dark' }).click()

    expect(root().classList.contains('dark')).toBe(true)
    expect(root().style.colorScheme).toBe('dark')
    expect(meta.content).toBe('#000000')
    expect(localStorage.getItem('theme-preference')).toBe('dark')
    await expect
      .element(page.getByRole('radio', { name: 'Dark' }))
      .toHaveAttribute('aria-checked', 'true')
  })

  it('choosing Light on a dark OS stays light', async () => {
    fakeSystemTheme(true)
    stopSync = startThemeSync()
    expect(root().classList.contains('dark')).toBe(true)
    render(ThemeSwitch)

    await page.getByRole('radio', { name: 'Light' }).click()

    expect(root().classList.contains('dark')).toBe(false)
    expect(root().style.colorScheme).toBe('light')
    expect(localStorage.getItem('theme-preference')).toBe('light')
  })

  it('on System, follows the OS live; on Light, ignores it', async () => {
    const system = fakeSystemTheme(false)
    stopSync = startThemeSync()
    render(ThemeSwitch)

    await page.getByRole('radio', { name: 'System' }).click()
    system.flip(true)
    expect(root().classList.contains('dark')).toBe(true)
    system.flip(false)
    expect(root().classList.contains('dark')).toBe(false)

    await page.getByRole('radio', { name: 'Light' }).click()
    system.flip(true)
    expect(root().classList.contains('dark')).toBe(false)
  })

  it('arrow keys move the choice, as in any radio group', async () => {
    fakeSystemTheme(false)
    localStorage.setItem('theme-preference', 'light')
    render(ThemeSwitch)

    const light = page.getByRole('radio', { name: 'Light' })
    await expect.element(light).toHaveAttribute('aria-checked', 'true')
    ;(light.element() as HTMLElement).focus()
    await userEvent.keyboard('{ArrowRight}')

    await expect
      .element(page.getByRole('radio', { name: 'Dark' }))
      .toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement?.getAttribute('data-theme-value')).toBe('dark')
    expect(localStorage.getItem('theme-preference')).toBe('dark')
  })

  it('two switches on screen stay in step', async () => {
    fakeSystemTheme(false)
    render(ThemeSwitch, { testid: 'first' })
    render(ThemeSwitch, { testid: 'second' })

    await page.getByTestId('first').getByRole('radio', { name: 'Dark' }).click()

    await expect
      .element(page.getByTestId('second').getByRole('radio', { name: 'Dark' }))
      .toHaveAttribute('aria-checked', 'true')
  })
})
