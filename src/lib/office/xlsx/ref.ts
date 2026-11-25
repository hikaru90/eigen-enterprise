/**
 * Cell addresses in A1 notation (ECMA-376 Part 1 §18.17.2.3): columns
 * A…XFD, rows 1…1048576. Internally rows and columns count from 0.
 */

export const MAX_ROWS = 1_048_576
export const MAX_COLS = 16_384

export type CellAddr = { row: number; col: number }
export type Range = { top: number; left: number; bottom: number; right: number }

export class XlsxRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XlsxRefError'
  }
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function colName(col: number): string {
  let n = col + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** "A" → 0, "aa" → 26; null when it is not a column name in range. */
export function colIndex(name: string): number | null {
  if (!/^[A-Za-z]{1,3}$/.test(name)) return null
  let n = 0
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1 < MAX_COLS ? n - 1 : null
}

export const cellName = (a: CellAddr): string => `${colName(a.col)}${a.row + 1}`

/** "B3" or "$B$3" → { row: 2, col: 1 }; null when it is not a cell address. */
export function parseCell(text: string): CellAddr | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text.trim())
  if (!m) return null
  const col = colIndex(m[1]!)
  const row = Number(m[2]) - 1
  if (col === null || row < 0 || row >= MAX_ROWS) return null
  return { row, col }
}

/** "A1:C4", "C4:A1" or "B2" → the normalised rectangle; null when it is not one. */
export function parseRange(text: string): Range | null {
  const [a, b, ...rest] = text.trim().split(':')
  if (rest.length > 0 || !a) return null
  const from = parseCell(a)
  const to = b === undefined ? from : parseCell(b)
  if (!from || !to) return null
  return {
    top: Math.min(from.row, to.row),
    left: Math.min(from.col, to.col),
    bottom: Math.max(from.row, to.row),
    right: Math.max(from.col, to.col),
  }
}

export function rangeName(r: Range): string {
  const a = cellName({ row: r.top, col: r.left })
  return r.top === r.bottom && r.left === r.right ? a : `${a}:${cellName({ row: r.bottom, col: r.right })}`
}

/** A cell address that must be valid (tool input, op input): throws XlsxRefError otherwise. */
export function requireCell(text: string): CellAddr {
  const a = parseCell(text)
  if (!a) throw new XlsxRefError(`“${text}” is not a cell address (like A1).`)
  return a
}

export function requireRange(text: string): Range {
  const r = parseRange(text)
  if (!r) throw new XlsxRefError(`“${text}” is not a cell range (like A1:C4).`)
  return r
}

/** One number per cell for map keys (row-major). */
export const cellKey = (row: number, col: number): number => row * MAX_COLS + col
export const keyAddr = (key: number): CellAddr => ({ row: Math.floor(key / MAX_COLS), col: key % MAX_COLS })
