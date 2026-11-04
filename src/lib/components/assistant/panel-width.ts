/**
 * The assistant panel's width (polish P-1): resizable by dragging its left
 * edge, between a readable minimum and 60% of the window, remembered per
 * browser. Storage is a per-viewer convenience: it may be missing or throw
 * (private mode, blocked site data) and the panel then opens at its default.
 */

export const PANEL_MIN_WIDTH = 320
export const PANEL_DEFAULT_WIDTH = 420
/** The panel never takes more than this share of the window. */
export const PANEL_MAX_RATIO = 0.6
export const PANEL_WIDTH_KEY = 'ee.assistant-panel-width'

/** The widest the panel may be in a window this wide (never below the minimum). */
export function panelMaxWidth(viewportWidth: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.floor(viewportWidth * PANEL_MAX_RATIO))
}

export function clampPanelWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH
  return Math.round(Math.min(Math.max(width, PANEL_MIN_WIDTH), panelMaxWidth(viewportWidth)))
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** The remembered width, or null when nothing (usable) is stored. */
export function readPanelWidth(storage: () => StorageLike): number | null {
  try {
    const raw = storage().getItem(PANEL_WIDTH_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null // storage unavailable: the default width applies
  }
}

export function writePanelWidth(storage: () => StorageLike, width: number): void {
  try {
    storage().setItem(PANEL_WIDTH_KEY, String(Math.round(width)))
  } catch {
    // storage unavailable: the width lasts for this page view only
  }
}
