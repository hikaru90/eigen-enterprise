import type { Range } from './ref'
import type { SheetData } from './workbook'
import {
  ctrlARange,
  jumpEdge,
  moveWithinSelection,
  usedEndPos,
  type NavDir,
  type Pos,
} from './selection'

/**
 * Keyboard command resolution for the spreadsheet grid (`sheet-grid.svelte`
 * and `xlsx-editor.svelte`). Pure decision mapping from KeyboardEvent fields
 * to navigation, selection, editing, clipboard, fill, or dialog commands.
 */

export type GridKeyAction =
  | { kind: 'move'; to: Pos; extend: boolean }
  | { kind: 'move_in_sel'; to: Pos }
  | { kind: 'select_range'; range: Range; active: Pos }
  | { kind: 'select_cols' }
  | { kind: 'select_rows' }
  | { kind: 'begin_edit'; initial: string | null }
  | { kind: 'clear' }
  | { kind: 'cancel' }
  | { kind: 'open_filter' }
  | { kind: 'fill_down' }
  | { kind: 'fill_right' }
  | { kind: 'open_find'; replace: boolean }
  | { kind: 'open_goto' }
  | { kind: 'end_mode_on' }
  | { kind: 'none' }

export type KeyState = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  active: Pos
  sel: Range
  selections: Range[]
  rows: number
  cols: number
  visibleRows: number
  visibleCols: number
  data: SheetData | null
  hasFilterAtActive: boolean
  endMode: boolean
  mergeBottomRight?: Pos | null
}

export function resolveGridKey(s: KeyState): GridKeyAction {
  const mod = s.ctrlKey || s.metaKey
  const ext = s.shiftKey
  const lower = s.key.toLowerCase()

  if (s.altKey && s.key === 'ArrowDown' && s.hasFilterAtActive) {
    return { kind: 'open_filter' }
  }

  // Shortcuts with Ctrl/Cmd
  if (mod && !s.altKey) {
    if (s.key === ' ') return { kind: 'select_cols' }
    if (lower === 'a') {
      const r = ctrlARange(s.data, s.active, s.sel, s.rows, s.cols)
      return { kind: 'select_range', range: r, active: s.active }
    }
    if (lower === 'd' && !ext) return { kind: 'fill_down' }
    if (lower === 'r' && !ext) return { kind: 'fill_right' }
    if (lower === 'f' && !ext) return { kind: 'open_find', replace: false }
    if (lower === 'h' && !ext) return { kind: 'open_find', replace: true }
    if (lower === 'g' && !ext) return { kind: 'open_goto' }
    if (s.key === 'Home') return { kind: 'move', to: { row: 0, col: 0 }, extend: ext }
    if (s.key === 'End') return { kind: 'move', to: usedEndPos(s.data), extend: ext }
    const arrowDir = arrowOf(s.key)
    if (arrowDir) {
      return {
        kind: 'move',
        to: jumpEdge(s.data, s.active, arrowDir, s.rows, s.cols),
        extend: ext,
      }
    }
    return { kind: 'none' }
  }

  if (s.key === 'F5' && !mod && !s.altKey) return { kind: 'open_goto' }
  if (s.key === 'F2' && !mod && !s.altKey) return { kind: 'begin_edit', initial: null }

  if (s.key === ' ' && ext && !mod && !s.altKey) return { kind: 'select_rows' }

  if (s.key === 'End' && !mod && !s.altKey) {
    return { kind: 'end_mode_on' }
  }

  const arrowDir = arrowOf(s.key)
  if (arrowDir && !s.altKey) {
    if (s.endMode) {
      return {
        kind: 'move',
        to: jumpEdge(s.data, s.active, arrowDir, s.rows, s.cols),
        extend: ext,
      }
    }
    const r = s.active.row
    const c = s.active.col
    const mr = !ext ? s.mergeBottomRight : null
    const to =
      arrowDir === 'down'
        ? { row: (mr ? mr.row : r) + 1, col: c }
        : arrowDir === 'up'
          ? { row: r - 1, col: c }
          : arrowDir === 'right'
            ? { row: r, col: (mr ? mr.col : c) + 1 }
            : { row: r, col: c - 1 }
    return { kind: 'move', to: clampPos(to, s.rows, s.cols), extend: ext }
  }

  if (s.key === 'Tab' && !s.altKey) {
    const inside = moveWithinSelection(s.selections, s.active, 'tab', ext)
    if (inside) return { kind: 'move_in_sel', to: inside }
    const mr = s.mergeBottomRight
    const to = ext
      ? { row: s.active.row, col: s.active.col - 1 }
      : { row: s.active.row, col: (mr ? mr.col : s.active.col) + 1 }
    return { kind: 'move', to: clampPos(to, s.rows, s.cols), extend: false }
  }

  if (s.key === 'Enter' && !s.altKey) {
    const inside = moveWithinSelection(s.selections, s.active, 'enter', ext)
    if (inside) return { kind: 'move_in_sel', to: inside }
    if (ext) {
      return {
        kind: 'move',
        to: clampPos({ row: s.active.row - 1, col: s.active.col }, s.rows, s.cols),
        extend: false,
      }
    }
    return { kind: 'begin_edit', initial: null }
  }

  if (s.key === 'Home' && !s.altKey) {
    return { kind: 'move', to: { row: s.active.row, col: 0 }, extend: ext }
  }

  if (s.key === 'PageDown') {
    if (s.altKey) {
      return {
        kind: 'move',
        to: clampPos({ row: s.active.row, col: s.active.col + s.visibleCols }, s.rows, s.cols),
        extend: ext,
      }
    }
    return {
      kind: 'move',
      to: clampPos({ row: s.active.row + s.visibleRows, col: s.active.col }, s.rows, s.cols),
      extend: ext,
    }
  }

  if (s.key === 'PageUp') {
    if (s.altKey) {
      return {
        kind: 'move',
        to: clampPos({ row: s.active.row, col: s.active.col - s.visibleCols }, s.rows, s.cols),
        extend: ext,
      }
    }
    return {
      kind: 'move',
      to: clampPos({ row: s.active.row - s.visibleRows, col: s.active.col }, s.rows, s.cols),
      extend: ext,
    }
  }

  if (s.key === 'Delete' || s.key === 'Backspace') return { kind: 'clear' }
  if (s.key === 'Escape') return { kind: 'cancel' }

  if (!mod && !s.altKey && s.key.length === 1) {
    return { kind: 'begin_edit', initial: s.key }
  }

  return { kind: 'none' }
}

function arrowOf(key: string): NavDir | null {
  if (key === 'ArrowUp') return 'up'
  if (key === 'ArrowDown') return 'down'
  if (key === 'ArrowLeft') return 'left'
  if (key === 'ArrowRight') return 'right'
  return null
}

function clampPos(p: Pos, rows: number, cols: number): Pos {
  return {
    row: Math.max(0, Math.min(rows - 1, p.row)),
    col: Math.max(0, Math.min(cols - 1, p.col)),
  }
}
