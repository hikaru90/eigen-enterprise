import Papa from 'papaparse'

/**
 * The CSV grid model (D2, W-1): parse/serialize with papaparse (RFC 4180 —
 * quoted fields, doubled quotes, commas and line breaks inside cells) and
 * pure, immutable grid operations for the editor. Row 0 is the header row.
 * A grid is always rectangular: every row has `width` cells.
 */

export type Grid = string[][]

/** RFC 4180 text → a rectangular grid (short rows padded with ''). Empty text is an empty grid. */
export function parseCsv(text: string): Grid {
  if (text.trim() === '') return []
  const out = Papa.parse<string[]>(text, { delimiter: ',', newline: undefined, quoteChar: '"', escapeChar: '"', skipEmptyLines: false, header: false })
  const fatal = out.errors.filter((e) => e.code !== 'UndetectableDelimiter')
  if (fatal.length > 0) throw new Error(`This file is not valid CSV: ${fatal[0]!.message} (row ${(fatal[0]!.row ?? 0) + 1}).`)
  let rows = out.data
  // A trailing line break ends the last record; it is not an extra empty record.
  if (rows.length > 0 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === '' && /\r?\n$/.test(text)) rows = rows.slice(0, -1)
  return rectangular(rows)
}

/** Grid → RFC 4180 text: CRLF line breaks, quotes only where needed, a final CRLF. */
export function serializeCsv(grid: Grid): string {
  if (grid.length === 0) return ''
  return Papa.unparse(rectangular(grid), { delimiter: ',', newline: '\r\n', quotes: false, quoteChar: '"', escapeChar: '"', escapeFormulae: false }) + '\r\n'
}

export function width(grid: Grid): number {
  return grid.reduce((w, r) => Math.max(w, r.length), 0)
}

export function rectangular(grid: Grid): Grid {
  const w = width(grid)
  return grid.map((r) => (r.length === w ? [...r] : [...r, ...Array<string>(w - r.length).fill('')]))
}

/** A new table: a header row and one empty row. */
export function emptyGrid(cols = 3): Grid {
  return [Array.from({ length: cols }, (_, i) => `Column ${i + 1}`), Array<string>(cols).fill('')]
}

export function setCell(grid: Grid, r: number, c: number, value: string): Grid {
  return grid.map((row, i) => (i === r ? row.map((v, j) => (j === c ? value : v)) : row))
}

export function insertRow(grid: Grid, at: number): Grid {
  const w = Math.max(width(grid), 1)
  const next = grid.map((r) => [...r])
  next.splice(clamp(at, 0, grid.length), 0, Array<string>(w).fill(''))
  return next
}

export function removeRow(grid: Grid, at: number): Grid {
  return grid.filter((_, i) => i !== at)
}

export function moveRow(grid: Grid, from: number, to: number): Grid {
  if (from === to || from < 0 || from >= grid.length) return grid
  const next = grid.map((r) => [...r])
  const [row] = next.splice(from, 1)
  next.splice(clamp(to, 0, next.length), 0, row!)
  return next
}

export function insertColumn(grid: Grid, at: number, header = ''): Grid {
  if (grid.length === 0) return [[header]]
  const pos = clamp(at, 0, width(grid))
  return grid.map((r, i) => {
    const next = [...r]
    next.splice(pos, 0, i === 0 ? header : '')
    return next
  })
}

export function removeColumn(grid: Grid, at: number): Grid {
  const next = grid.map((r) => r.filter((_, j) => j !== at))
  return width(next) === 0 ? [] : next
}

export function moveColumn(grid: Grid, from: number, to: number): Grid {
  const w = width(grid)
  if (from === to || from < 0 || from >= w) return grid
  return grid.map((r) => {
    const next = [...r]
    const [cell] = next.splice(from, 1)
    next.splice(clamp(to, 0, w - 1), 0, cell!)
    return next
  })
}

/**
 * A block copied from a spreadsheet (tab-separated, one line per row; cells
 * may be quoted the way spreadsheets quote them) — rows of cells.
 */
export function parseClipboardBlock(text: string): Grid {
  const trimmed = text.replace(/\r?\n$/, '')
  if (trimmed === '') return []
  if (!trimmed.includes('\t')) return trimmed.split(/\r?\n/).map((line) => [line])
  const out = Papa.parse<string[]>(trimmed, { delimiter: '\t', quoteChar: '"', escapeChar: '"', skipEmptyLines: false, header: false })
  return out.data
}

/** Pastes `block` with its top-left at (r, c), growing the grid with rows/columns as needed. */
export function pasteBlock(grid: Grid, r: number, c: number, block: Grid): Grid {
  if (block.length === 0) return grid
  const blockW = width(block)
  let next = rectangular(grid)
  while (next.length < r + block.length) next = insertRow(next, next.length)
  while (width(next) < c + blockW) next = insertColumn(next, width(next))
  return next.map((row, i) => {
    const src = block[i - r]
    if (!src) return row
    return row.map((v, j) => (j >= c && j < c + blockW ? (src[j - c] ?? '') : v))
  })
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}
