import { strToU8 } from 'fflate'
import { relsPartOf } from '../ooxml/package'
import { cellKey, parseCell } from './ref'
import { argb } from './style-records'
import { relativeTarget, XlsxError, type Workbook } from './workbook'
import { CT_SST, kid, kids, make, NS_MAIN, REL_SST, setText, textOf } from './xml'

/**
 * Rich text inside a cell (ECMA-376 Part 1 §18.4: a string item of formatted
 * runs, `<si><r><rPr>…</rPr><t>…</t></r>…</si>`): bold, italic, underline,
 * strikethrough, colour, size and font per run. Read from the shared-string
 * table or an inline string; written as a new shared-string item (what Excel
 * writes). A run's format left out is the cell's own.
 */

export type RichRun = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** "#RRGGBB". */
  color?: string
  /** Points. */
  size?: number
  font?: string
}

export type RunFormat = Omit<RichRun, 'text'>

const RUN_KEYS = ['bold', 'italic', 'underline', 'strike', 'color', 'size', 'font'] as const

const on = (el: Element | null) => {
  if (!el) return false
  const v = el.getAttribute('val')
  return v === null || (v !== '0' && v !== 'false' && v !== 'none')
}

/** One `<r>` element as a run. */
function readRun(r: Element): RichRun {
  const run: RichRun = { text: textOf(kid(r, 't')) }
  const pr = kid(r, 'rPr')
  if (!pr) return run
  if (on(kid(pr, 'b'))) run.bold = true
  if (on(kid(pr, 'i'))) run.italic = true
  if (on(kid(pr, 'u'))) run.underline = true
  if (on(kid(pr, 'strike'))) run.strike = true
  const color = kid(pr, 'color')?.getAttribute('rgb')
  if (color && /^[0-9A-Fa-f]{8}$/.test(color)) run.color = `#${color.slice(2).toUpperCase()}`
  const sz = kid(pr, 'sz')?.getAttribute('val')
  if (sz && Number(sz) > 0) run.size = Number(sz)
  const font = kid(pr, 'rFont')?.getAttribute('val')
  if (font) run.font = font
  return run
}

/** A string item's runs, or null when it is plain text (no `<r>`). */
export function runsOfItem(si: Element): RichRun[] | null {
  const rs = kids(si, 'r')
  return rs.length > 0 ? rs.map(readRun) : null
}

/** The shared-string indexes whose item has runs. */
function richItems(wb: Workbook): Map<number, RichRun[]> {
  const part = wb.sstPart()
  const out = new Map<number, RichRun[]>()
  if (!part) return out
  kids(wb.pkg.xml(part).documentElement!, 'si').forEach((si, i) => {
    const runs = runsOfItem(si)
    if (runs) out.set(i, runs)
  })
  return out
}

/** Every cell of a sheet that holds rich text, by cell key (what the grid draws per run). */
export function richCells(wb: Workbook, sheet: string): Map<number, RichRun[]> {
  const info = wb.requireWorksheet(sheet)
  const items = richItems(wb)
  const out = new Map<number, RichRun[]>()
  const data = kid(wb.pkg.xml(info.part).documentElement!, 'sheetData')
  if (!data) return out
  for (const row of kids(data, 'row'))
    for (const c of kids(row, 'c')) {
      const t = c.getAttribute('t')
      if (t !== 's' && t !== 'inlineStr') continue
      const addr = parseCell(c.getAttribute('r') ?? '')
      if (!addr) continue
      let runs: RichRun[] | null
      if (t === 's') runs = items.get(Number(textOf(kid(c, 'v')))) ?? null
      else {
        const is = kid(c, 'is')
        runs = is ? runsOfItem(is) : null
      }
      if (runs) out.set(cellKey(addr.row, addr.col), runs)
    }
  return out
}

/** Neighbouring runs with the same format become one; empty runs go. */
export function normalizeRuns(runs: RichRun[]): RichRun[] {
  const out: RichRun[] = []
  for (const r of runs) {
    if (r.text === '') continue
    const last = out[out.length - 1]
    if (last && sameFormat(last, r)) last.text += r.text
    else out.push({ ...r })
  }
  return out
}

export function sameFormat(a: RunFormat, b: RunFormat): boolean {
  return RUN_KEYS.every((k) => (a[k] ?? undefined) === (b[k] ?? undefined))
}

export const isPlain = (runs: RichRun[]) =>
  runs.every((r) => RUN_KEYS.every((k) => r[k] === undefined || r[k] === false))

export function checkRuns(runs: RichRun[], where: string) {
  if (runs.length === 0) throw new XlsxError(`${where}: rich text needs at least one run.`)
  for (const r of runs) {
    if (typeof r.text !== 'string') throw new XlsxError(`${where}: every run needs its text.`)
    if (r.color !== undefined) argb(r.color)
    if (r.size !== undefined && !(r.size >= 1 && r.size <= 409))
      throw new XlsxError(`${where}: a run's size is 1 to 409 points (${r.size} given).`)
  }
  const len = runs.reduce((n, r) => n + r.text.length, 0)
  if (len > 32767) throw new XlsxError(`${where}: a cell holds at most 32767 characters.`)
}

/** Writes the runs as a `<r>` sequence into a string item element. */
function writeRuns(doc: XMLDocument, si: Element, runs: RichRun[]) {
  for (const run of runs) {
    const r = make(doc, 'r')
    const props: Element[] = []
    const prop = (name: string, val?: string) => {
      const el = make(doc, name)
      if (val !== undefined) el.setAttribute('val', val)
      props.push(el)
    }
    // CT_RPrElt is a choice; this is the order Excel writes.
    if (run.bold) prop('b')
    if (run.italic) prop('i')
    if (run.strike) prop('strike')
    if (run.underline) prop('u')
    if (run.size !== undefined) prop('sz', String(run.size))
    if (run.color !== undefined) {
      const c = make(doc, 'color')
      c.setAttribute('rgb', argb(run.color))
      props.push(c)
    }
    if (run.font !== undefined) prop('rFont', run.font)
    if (props.length > 0) {
      const pr = make(doc, 'rPr')
      for (const p of props) pr.appendChild(p)
      r.appendChild(pr)
    }
    const t = make(doc, 't')
    setText(doc, t, run.text)
    if (/^\s|\s$|\n/.test(run.text))
      t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
    r.appendChild(t)
    si.appendChild(r)
  }
}

/** The shared-string index of rich text `runs` (an identical item is reused; else appended). */
export function richStringIndex(wb: Workbook, runs: RichRun[]): number {
  let part = wb.sstPart()
  if (!part) {
    part = '/xl/sharedStrings.xml'
    for (let n = 2; wb.pkg.has(part); n++) part = `/xl/sharedStrings${n}.xml`
    wb.write(
      part,
      strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS_MAIN}" count="0" uniqueCount="0"/>`,
      ),
      CT_SST,
    )
    wb.touch(relsPartOf(wb.part))
    wb.pkg.addRelationship(wb.part, REL_SST, relativeTarget(wb.part, part))
  }
  const doc = wb.edit(part)
  const root = doc.documentElement!
  const items = kids(root, 'si')
  const want = JSON.stringify(runs)
  for (let i = 0; i < items.length; i++) {
    const have = runsOfItem(items[i]!)
    if (have && JSON.stringify(have) === want) return i
  }
  const si = make(doc, 'si')
  writeRuns(doc, si, runs)
  root.appendChild(si)
  root.setAttribute('uniqueCount', String(items.length + 1))
  root.setAttribute('count', String(Number(root.getAttribute('count') ?? items.length) + 1))
  wb.forgetSharedStrings()
  return items.length
}

/** Puts rich text into a cell element (made by the caller): a shared string of runs. */
export function setRichCell(wb: Workbook, cell: Element, runs: RichRun[]) {
  const doc = cell.ownerDocument!
  const index = richStringIndex(wb, runs)
  for (const k of kids(cell, undefined))
    if (k.localName === 'f' || k.localName === 'v' || k.localName === 'is') cell.removeChild(k)
  cell.removeAttribute('cm')
  cell.removeAttribute('vm')
  cell.setAttribute('t', 's')
  const v = make(doc, 'v')
  v.appendChild(doc.createTextNode(String(index)))
  cell.insertBefore(v, kid(cell, 'extLst'))
}

// ---------------------------------------------------------------------------
// Editing runs while the text changes (the cell editor)

/** The format at character `i` (the run it falls in; at a boundary the run before). */
export function formatAt(runs: RichRun[], i: number): RunFormat {
  let pos = 0
  for (const r of runs) {
    const end = pos + r.text.length
    if (i <= end && (i > pos || pos === 0)) return strip(r)
    pos = end
  }
  const last = runs[runs.length - 1]
  return last ? strip(last) : {}
}

function strip(r: RichRun): RunFormat {
  const { text: _text, ...f } = r
  void _text
  return f
}

/** Runs with `patch` applied to characters start…end (end exclusive). */
export function formatRange(
  runs: RichRun[],
  start: number,
  end: number,
  patch: RunFormat,
): RichRun[] {
  const out: RichRun[] = []
  let pos = 0
  for (const r of runs) {
    const a = pos
    const b = pos + r.text.length
    pos = b
    const lo = Math.max(a, start)
    const hi = Math.min(b, end)
    if (lo >= hi) {
      out.push({ ...r })
      continue
    }
    if (lo > a) out.push({ ...r, text: r.text.slice(0, lo - a) })
    out.push(clean({ ...r, ...patch, text: r.text.slice(lo - a, hi - a) }))
    if (hi < b) out.push({ ...r, text: r.text.slice(hi - a) })
  }
  return normalizeRuns(out)
}

function clean(r: RichRun): RichRun {
  const out: RichRun = { text: r.text }
  if (r.bold) out.bold = true
  if (r.italic) out.italic = true
  if (r.underline) out.underline = true
  if (r.strike) out.strike = true
  if (r.color) out.color = r.color
  if (r.size) out.size = r.size
  if (r.font) out.font = r.font
  return out
}

/**
 * The runs after the text changed from `before` to `after` (one edit: the
 * common start and end are kept with their formats; what was typed takes
 * the format of the character before it).
 */
export function retext(runs: RichRun[], before: string, after: string): RichRun[] {
  if (before === after) return runs
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++
  const typed = after.slice(head, after.length - tail)
  const fmt = formatAt(runs, head)
  const out: RichRun[] = []
  let pos = 0
  let placed = false
  for (const r of runs) {
    const a = pos
    const b = pos + r.text.length
    pos = b
    const keepHead = r.text.slice(0, Math.max(0, Math.min(b, head) - a))
    const keepTail = r.text.slice(Math.max(0, before.length - tail - a))
    if (keepHead) out.push({ ...r, text: keepHead })
    if (!placed && b >= head) {
      if (typed) out.push(clean({ ...fmt, text: typed }))
      placed = true
    }
    if (b > before.length - tail && keepTail) out.push({ ...r, text: keepTail })
  }
  if (!placed && typed) out.push(clean({ ...fmt, text: typed }))
  return normalizeRuns(out)
}

/** The plain text of runs. */
export const runsText = (runs: RichRun[]) => runs.map((r) => r.text).join('')

/** CSS for a run (what the grid draws). */
export function runCss(r: RunFormat): string {
  const css: string[] = []
  if (r.bold) css.push('font-weight: 600')
  if (r.italic) css.push('font-style: italic')
  const deco = [r.underline ? 'underline' : '', r.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  if (deco) css.push(`text-decoration: ${deco}`)
  if (r.color) css.push(`color: ${r.color}`)
  if (r.size) css.push(`font-size: ${Math.round(r.size * 1.27)}px`)
  if (r.font) css.push(`font-family: "${r.font.replace(/"/g, '')}"`)
  return css.join('; ')
}
