/**
 * Light · Dark · System: a display preference of this device (like sound and
 * voice in the settings menu), not company state. It lives in localStorage
 * under `theme-preference`, which the pre-paint script in src/app.html reads
 * so the first frame is already in the right theme; there is no server route,
 * so nothing maps in src/lib/kernel/ui-parity.ts.
 *
 * The root layout runs `startThemeSync` once: it applies the stored choice,
 * follows the OS live while on System, and re-applies when a switch calls
 * `setThemePreference` (which announces `theme-preference-change`).
 */

export type ThemePreference = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'theme-preference'
export const THEME_CHANGE_EVENT = 'theme-preference-change'

export const THEME_PREFERENCES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** A stored value as a preference: anything but light or dark is System, exactly as app.html reads it. */
export function parseThemePreference(raw: string | null): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function resolveDark(preference: ThemePreference, systemDark: boolean): boolean {
  return preference === 'dark' || (preference === 'system' && systemDark)
}

export function readThemePreference(): ThemePreference {
  return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY))
}

/** Stores the choice on this device and announces it, so the shell applies it at once. */
export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(THEME_STORAGE_KEY, preference)
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { preference } }))
}

function applyDark(isDark: boolean): void {
  const root = document.documentElement
  root.classList.toggle('dark', isDark)
  root.style.colorScheme = isDark ? 'dark' : 'light'
  const meta = document.getElementById('theme-color-meta')
  if (!meta) return
  const themeColor = getComputedStyle(root).getPropertyValue('--theme-color').trim()
  if (themeColor) meta.setAttribute('content', themeColor)
}

/** Applies the stored preference and keeps applying it; returns the stop function. */
export function startThemeSync(): () => void {
  const media = window.matchMedia(DARK_QUERY)
  let preference = readThemePreference()
  applyDark(resolveDark(preference, media.matches))

  const onSystemChange = (event: MediaQueryListEvent) => {
    if (preference === 'system') applyDark(event.matches)
  }
  const onPreferenceChange = (event: Event) => {
    const detail = (event as CustomEvent<{ preference?: string }>).detail
    preference = parseThemePreference(detail?.preference ?? null)
    applyDark(resolveDark(preference, media.matches))
  }
  media.addEventListener('change', onSystemChange)
  window.addEventListener(THEME_CHANGE_EVENT, onPreferenceChange)
  return () => {
    media.removeEventListener('change', onSystemChange)
    window.removeEventListener(THEME_CHANGE_EVENT, onPreferenceChange)
  }
}
