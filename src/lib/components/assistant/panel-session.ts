import type { AssistantTab } from './types'

/**
 * Whether the assistant panel is open, and on which tab, for this browser tab
 * (board de821eda). Client-side navigation keeps the shell and so the panel;
 * a full page load (a reload, the first navigation after an update) starts the
 * shell afresh, and this brings the panel back as it was. The conversation
 * itself comes back from the server; speech that was playing cannot continue
 * across a full load. sessionStorage: per tab, gone when the tab closes. A
 * per-viewer convenience — storage may be missing or throw, and the panel then
 * starts closed.
 */
export const PANEL_SESSION_KEY = 'ee.assistant-panel-session'

export type PanelSession = { open: boolean; tab: AssistantTab }

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

const TABS: readonly AssistantTab[] = ['chat', 'history', 'activity']

export function readPanelSession(storage: () => StorageLike): PanelSession | null {
  let raw: string | null
  try {
    raw = storage().getItem(PANEL_SESSION_KEY)
  } catch {
    return null // storage unavailable: nothing to restore
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { open, tab } = parsed as { open?: unknown; tab?: unknown }
  if (typeof open !== 'boolean' || !TABS.includes(tab as AssistantTab)) return null
  return { open, tab: tab as AssistantTab }
}

export function writePanelSession(storage: () => StorageLike, session: PanelSession): void {
  try {
    storage().setItem(PANEL_SESSION_KEY, JSON.stringify(session))
  } catch {
    // storage unavailable: the panel lasts for this page view only
  }
}
