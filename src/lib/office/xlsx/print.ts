import type { SheetEditor } from './editor'
import type { OpResult } from './ops'
import { parseA1Ref } from '@borgar/fx/xlsx'
import { displayValue, formatCode, type SheetLocale } from './format'
import { borderCss, fontFamilyCss, verticalOf } from './grid-style'
import {
  cellKey,
  colName,
  MAX_COLS,
  MAX_ROWS,
  parseRange,
  rangeName,
  requireRange,
  type Range,
} from './ref'
import { richCells, runCss } from './rich-text'
import { WORKSHEET_ORDER } from './sheet-order'
import { quoteSheet } from './shift'
import { XlsxError, type SheetInfo, type Workbook } from './workbook'
import { insertInOrder, kid, kids, make, setText, WORKBOOK_ORDER } from './xml'

/**
 * Page setup, print options, view options, and self-contained HTML print
 * rendering for PDF export (ECMA-376 Part 1 §18.3.1.62–64, §18.3.1.70,
 * §18.3.1.87, §18.2.6 Print_Area / Print_Titles).
 *
 * Browser-safe: Chromium PDF printing lives in ./print-pdf.ts so browser
 * bundles never import Playwright or Node fs.
 */

export const PAPER_SIZES = ['a4', 'letter', 'legal', 'a3', 'a5'] as const
export type PaperSize = (typeof PAPER_SIZES)[number]
export type PageOrientation = 'portrait' | 'landscape'

const PAPER_CODE: Record<PaperSize, number> = {
  letter: 1,
  legal: 5,
  a3: 8,
  a4: 9,
  a5: 11,
}

const CODE_TO_PAPER: Record<number, PaperSize> = {
  1: 'letter',
  5: 'legal',
  8: 'a3',
  9: 'a4',
  11: 'a5',
}

/** Paper dimensions in inches (portrait). */
const PAPER_INCHES: Record<PaperSize, { w: number; h: number; css: string }> = {
  a4: { w: 8.27, h: 11.69, css: 'A4' },
  letter: { w: 8.5, h: 11, css: 'letter' },
  legal: { w: 8.5, h: 14, css: 'legal' },
  a3: { w: 11.69, h: 16.54, css: 'A3' },
  a5: { w: 5.83, h: 8.27, css: 'A5' },
}

export type PageMargins = {
  top: number
  bottom: number
  left: number
  right: number
  header: number
  footer: number
}

export type PageSetup = {
  orientation: PageOrientation
  paperSize: PaperSize
  scale: number
  fitToWidth: number | null
  fitToHeight: number | null
  margins: PageMargins
  printGridlines: boolean
  printHeadings: boolean
  centerHorizontally: boolean
  centerVertically: boolean
  printArea: string | null
  repeatRows: string | null
  repeatCols: string | null
}

export type PageSetupOp = {
  op: 'set_page_setup'
  sheet: string
  orientation?: PageOrientation
  paperSize?: PaperSize
  scale?: number
  fitToWidth?: number | null
  fitToHeight?: number | null
  margins?: Partial<PageMargins>
  printGridlines?: boolean
  printHeadings?: boolean
  centerHorizontally?: boolean
  centerVertically?: boolean
  printArea?: string | null
  repeatRows?: string | null
  repeatCols?: string | null
}

export type ViewOptions = {
  showGridlines: boolean
  showHeadings: boolean
  zoomScale: number
}

export type ViewOptionsOp = {
  op: 'set_view_options'
  sheet: string
  showGridlines?: boolean
  showHeadings?: boolean
  zoomScale?: number
}

export const PRINT_AREA_NAME = '_xlnm.Print_Area'
export const PRINT_TITLES_NAME = '_xlnm.Print_Titles'
const SHEET_PR_ORDER = ['tabColor', 'outlinePr', 'pageSetUpPr'] as const

const boolAttr = (el: Element | null, attr: string, def: boolean) => {
  if (!el || !el.hasAttribute(attr)) return def
  const v = el.getAttribute(attr)
  return v === '1' || v === 'true'
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch === "'") q = !q
    if (ch === ',' && !q) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function parsePrintTitles(formula: string): {
  repeatRows: string | null
  repeatCols: string | null
} {
  let repeatRows: string | null = null
  let repeatCols: string | null = null
  for (const part of splitTopLevelCommas(formula)) {
    const bang = part.lastIndexOf('!')
    const ref = (bang >= 0 ? part.slice(bang + 1) : part).replace(/\$/g, '')
    if (/^\d+(?::\d+)?$/.test(ref)) repeatRows = ref.includes(':') ? ref : `${ref}:${ref}`
    else if (/^[A-Za-z]{1,3}(?::[A-Za-z]{1,3})?$/.test(ref))
      repeatCols = (ref.includes(':') ? ref : `${ref}:${ref}`).toUpperCase()
  }
  return { repeatRows, repeatCols }
}

/** Reads a sheet's `pageSetup`, `printOptions`, `pageMargins`, `Print_Area` and `Print_Titles`. */
export function pageSetupOf(wb: Workbook, sheet: string): PageSetup {
  const info = wb.requireWorksheet(sheet)
  const root = wb.pkg.xml(info.part).documentElement!
  const ps = kid(root, 'pageSetup')
  const po = kid(root, 'printOptions')
  const pm = kid(root, 'pageMargins')
  const pr = kid(root, 'sheetPr')
  const psp = pr ? kid(pr, 'pageSetUpPr') : null
  const fitToPage = boolAttr(psp, 'fitToPage', false)

  const ori = ps?.getAttribute('orientation')
  const orientation: PageOrientation = ori === 'landscape' ? 'landscape' : 'portrait'
  const paperCode = Number(ps?.getAttribute('paperSize') ?? 9)
  const paperSize: PaperSize = CODE_TO_PAPER[paperCode] ?? 'a4'
  const scale = Math.max(10, Math.min(400, Number(ps?.getAttribute('scale') ?? 100) || 100))
  const ftwRaw = ps?.getAttribute('fitToWidth')
  const fthRaw = ps?.getAttribute('fitToHeight')
  const fitToWidth = fitToPage && ftwRaw !== null ? Number(ftwRaw) : null
  const fitToHeight = fitToPage && fthRaw !== null ? Number(fthRaw) : null

  const numAttr = (el: Element | null, a: string, def: number) => {
    const raw = el?.getAttribute(a)
    const v = raw === null || raw === undefined ? Number.NaN : Number(raw)
    return Number.isFinite(v) ? v : def
  }
  const margins: PageMargins = {
    left: numAttr(pm, 'left', 0.7),
    right: numAttr(pm, 'right', 0.7),
    top: numAttr(pm, 'top', 0.75),
    bottom: numAttr(pm, 'bottom', 0.75),
    header: numAttr(pm, 'header', 0.3),
    footer: numAttr(pm, 'footer', 0.3),
  }

  const names = wb.definedNames().filter((n) => n.localSheet === info.index)
  const areaDef = names.find((n) => n.name === PRINT_AREA_NAME)
  const titlesDef = names.find((n) => n.name === PRINT_TITLES_NAME)
  let printArea: string | null = null
  if (areaDef) {
    const parsed = parseA1Ref(areaDef.formula.replace(/^=/, '')) as
      | {
          range?: {
            top: number | null
            left: number | null
            bottom: number | null
            right: number | null
          }
        }
      | undefined
    const r = parsed?.range
    if (r && r.top !== null && r.left !== null) {
      printArea = rangeName({
        top: r.top,
        left: r.left,
        bottom: r.bottom ?? r.top,
        right: r.right ?? r.left,
      })
    }
  }
  const titles = titlesDef
    ? parsePrintTitles(titlesDef.formula.replace(/^=/, ''))
    : { repeatRows: null, repeatCols: null }

  return {
    orientation,
    paperSize,
    scale,
    fitToWidth,
    fitToHeight,
    margins,
    printGridlines: boolAttr(po, 'gridLines', false),
    printHeadings: boolAttr(po, 'headings', false),
    centerHorizontally: boolAttr(po, 'horizontalCentered', false),
    centerVertically: boolAttr(po, 'verticalCentered', false),
    printArea,
    repeatRows: titles.repeatRows,
    repeatCols: titles.repeatCols,
  }
}

/** Reads a sheet's gridlines, headings and zoom from its first `<sheetView>`. */
export function viewOptionsOf(wb: Workbook, sheet: string): ViewOptions {
  const info = wb.requireWorksheet(sheet)
  const views = kid(wb.pkg.xml(info.part).documentElement!, 'sheetViews')
  const view = views ? (kids(views, 'sheetView')[0] ?? null) : null
  const zoomRaw = Number(view?.getAttribute('zoomScale') ?? 100)
  return {
    showGridlines: boolAttr(view, 'showGridLines', true),
    showHeadings: boolAttr(view, 'showRowColHeaders', true),
    zoomScale: Number.isFinite(zoomRaw) && zoomRaw >= 10 && zoomRaw <= 400 ? zoomRaw : 100,
  }
}

function setLocalDefinedName(wb: Workbook, info: SheetInfo, name: string, formula: string | null) {
  const root = wb.pkg.xml(wb.part).documentElement!
  const namesEl = kid(root, 'definedNames')
  const existing = namesEl
    ? kids(namesEl, 'definedName').find(
        (el) =>
          el.getAttribute('name') === name &&
          el.getAttribute('localSheetId') === String(info.index),
      )
    : undefined
  if (formula === null && !existing) return
  const doc = wb.edit(wb.part)
  if (formula === null) {
    namesEl!.removeChild(existing!)
    if (kids(namesEl!, 'definedName').length === 0) doc.documentElement!.removeChild(namesEl!)
    return
  }
  let names = namesEl
  if (!names) {
    names = make(doc, 'definedNames')
    insertInOrder(doc.documentElement!, names, WORKBOOK_ORDER)
  }
  let el = existing
  if (!el) {
    el = make(doc, 'definedName')
    el.setAttribute('name', name)
    el.setAttribute('localSheetId', String(info.index))
    names.appendChild(el)
  }
  setText(doc, el, formula)
}

function normalizeRepeatRows(spec: string): { text: string; from: number; to: number } {
  const m = /^\$?(\d+)(?::\$?(\d+))?$/.exec(spec.trim())
  if (!m) throw new XlsxError(`“${spec}” is not a row range (like 1:2).`)
  const a = Number(m[1]) - 1
  const b = Number(m[2] ?? m[1]) - 1
  if (a < 0 || b < 0 || a >= MAX_ROWS || b >= MAX_ROWS)
    throw new XlsxError(`Row range “${spec}” is outside the sheet.`)
  const from = Math.min(a, b)
  const to = Math.max(a, b)
  return { text: `$${from + 1}:$${to + 1}`, from, to }
}

function normalizeRepeatCols(spec: string): { text: string; from: number; to: number } {
  const parts = spec.trim().replace(/\$/g, '').split(':')
  if (parts.length > 2) throw new XlsxError(`“${spec}” is not a column range (like A:B).`)
  const parseCol = (s: string) => {
    if (!/^[A-Za-z]{1,3}$/.test(s)) return -1
    let n = 0
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n - 1
  }
  const a = parseCol(parts[0]!)
  const b = parseCol(parts[1] ?? parts[0]!)
  if (a < 0 || b < 0 || a >= MAX_COLS || b >= MAX_COLS)
    throw new XlsxError(`Column range “${spec}” is outside the sheet.`)
  const from = Math.min(a, b)
  const to = Math.max(a, b)
  return { text: `$${colName(from)}:$${colName(to)}`, from, to }
}

function runPageSetup(wb: Workbook, op: PageSetupOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  if (op.paperSize && !PAPER_SIZES.includes(op.paperSize))
    throw new XlsxError(`“${op.paperSize}” is not a supported paper size.`)
  if (op.orientation && op.orientation !== 'portrait' && op.orientation !== 'landscape')
    throw new XlsxError(`“${op.orientation}” is not a page orientation.`)
  if (op.scale !== undefined && (!Number.isFinite(op.scale) || op.scale < 10 || op.scale > 400))
    throw new XlsxError('Page scale must be between 10% and 400%.')

  const cur = pageSetupOf(wb, info.name)
  const doc = wb.edit(info.part)
  const root = doc.documentElement!

  const ensureChild = (name: string) => {
    let el = kid(root, name)
    if (!el) {
      el = make(doc, name)
      insertInOrder(root, el, WORKSHEET_ORDER)
    }
    return el
  }

  if (
    op.printGridlines !== undefined ||
    op.printHeadings !== undefined ||
    op.centerHorizontally !== undefined ||
    op.centerVertically !== undefined
  ) {
    const po = ensureChild('printOptions')
    const setBool = (attr: string, val: boolean | undefined) => {
      if (val === undefined) return
      if (val) po.setAttribute(attr, '1')
      else po.removeAttribute(attr)
    }
    setBool('gridLines', op.printGridlines)
    setBool('headings', op.printHeadings)
    setBool('horizontalCentered', op.centerHorizontally)
    setBool('verticalCentered', op.centerVertically)
  }

  if (op.margins) {
    const pm = ensureChild('pageMargins')
    const next = { ...cur.margins, ...op.margins }
    for (const k of ['left', 'right', 'top', 'bottom', 'header', 'footer'] as const) {
      const v = next[k]
      if (!Number.isFinite(v) || v < 0 || v > 10)
        throw new XlsxError(`Margin ${k} (${v}) must be 0 to 10 inches.`)
      pm.setAttribute(k, String(v))
    }
  }

  if (
    op.orientation !== undefined ||
    op.paperSize !== undefined ||
    op.scale !== undefined ||
    op.fitToWidth !== undefined ||
    op.fitToHeight !== undefined
  ) {
    const ps = ensureChild('pageSetup')
    ps.setAttribute('orientation', op.orientation ?? cur.orientation)
    ps.setAttribute('paperSize', String(PAPER_CODE[op.paperSize ?? cur.paperSize]))
    const nextW = op.fitToWidth !== undefined ? op.fitToWidth : cur.fitToWidth
    const nextH = op.fitToHeight !== undefined ? op.fitToHeight : cur.fitToHeight
    const fitOn = (nextW !== null && nextW >= 0) || (nextH !== null && nextH >= 0)
    if (op.scale !== undefined) ps.setAttribute('scale', String(Math.round(op.scale)))
    else if (!ps.hasAttribute('scale')) ps.setAttribute('scale', String(cur.scale))
    if (fitOn) {
      ps.setAttribute('fitToWidth', String(nextW ?? 0))
      ps.setAttribute('fitToHeight', String(nextH ?? 0))
    } else {
      ps.removeAttribute('fitToWidth')
      ps.removeAttribute('fitToHeight')
    }
    let pr = kid(root, 'sheetPr')
    if (fitOn) {
      if (!pr) {
        pr = make(doc, 'sheetPr')
        insertInOrder(root, pr, WORKSHEET_ORDER)
      }
      let psp = kid(pr, 'pageSetUpPr')
      if (!psp) {
        psp = make(doc, 'pageSetUpPr')
        insertInOrder(pr, psp, SHEET_PR_ORDER)
      }
      psp.setAttribute('fitToPage', '1')
    } else if (pr) {
      const psp = kid(pr, 'pageSetUpPr')
      if (psp) {
        psp.removeAttribute('fitToPage')
        if (psp.attributes.length === 0 && kids(psp, undefined).length === 0) pr.removeChild(psp)
      }
      if (pr.attributes.length === 0 && kids(pr, undefined).length === 0) root.removeChild(pr)
    }
  }

  if (op.printArea !== undefined) {
    if (op.printArea === null || op.printArea.trim() === '') {
      setLocalDefinedName(wb, info, PRINT_AREA_NAME, null)
    } else {
      const r = requireRange(op.printArea)
      const q = quoteSheet(info.name)
      const abs = (row: number, col: number) => `$${colName(col)}$${row + 1}`
      setLocalDefinedName(
        wb,
        info,
        PRINT_AREA_NAME,
        `${q}!${abs(r.top, r.left)}:${abs(r.bottom, r.right)}`,
      )
    }
  }

  if (op.repeatRows !== undefined || op.repeatCols !== undefined) {
    const nextRows =
      op.repeatRows !== undefined
        ? op.repeatRows === null || op.repeatRows.trim() === ''
          ? null
          : normalizeRepeatRows(op.repeatRows).text
        : cur.repeatRows
          ? normalizeRepeatRows(cur.repeatRows).text
          : null
    const nextCols =
      op.repeatCols !== undefined
        ? op.repeatCols === null || op.repeatCols.trim() === ''
          ? null
          : normalizeRepeatCols(op.repeatCols).text
        : cur.repeatCols
          ? normalizeRepeatCols(cur.repeatCols).text
          : null
    const q = quoteSheet(info.name)
    const parts = [nextCols ? `${q}!${nextCols}` : '', nextRows ? `${q}!${nextRows}` : ''].filter(
      Boolean,
    )
    setLocalDefinedName(wb, info, PRINT_TITLES_NAME, parts.length ? parts.join(',') : null)
  }

  wb.invalidate()
  return { sheets: [info.name] }
}

function runViewOptions(wb: Workbook, op: ViewOptionsOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  if (
    op.zoomScale !== undefined &&
    (!Number.isFinite(op.zoomScale) || op.zoomScale < 10 || op.zoomScale > 400)
  )
    throw new XlsxError('Zoom must be between 10% and 400%.')
  const doc = wb.edit(info.part)
  const root = doc.documentElement!
  let views = kid(root, 'sheetViews')
  if (!views) {
    views = make(doc, 'sheetViews')
    insertInOrder(root, views, WORKSHEET_ORDER)
  }
  let view = kids(views, 'sheetView')[0]
  if (!view) {
    view = make(doc, 'sheetView')
    view.setAttribute('workbookViewId', '0')
    views.insertBefore(view, views.firstChild)
  }
  if (op.showGridlines !== undefined) {
    if (op.showGridlines) view.removeAttribute('showGridLines')
    else view.setAttribute('showGridLines', '0')
  }
  if (op.showHeadings !== undefined) {
    if (op.showHeadings) view.removeAttribute('showRowColHeaders')
    else view.setAttribute('showRowColHeaders', '0')
  }
  if (op.zoomScale !== undefined) {
    const z = Math.round(op.zoomScale)
    if (z === 100) view.removeAttribute('zoomScale')
    else view.setAttribute('zoomScale', String(z))
  }
  wb.invalidate()
  return { sheets: [info.name] }
}

export function runPrintOp(wb: Workbook, op: PageSetupOp | ViewOptionsOp): OpResult {
  return op.op === 'set_page_setup' ? runPageSetup(wb, op) : runViewOptions(wb, op)
}

// ---------------------------------------------------------------------------
// Self-contained print HTML (for PDF export via Chromium)

export type RenderHtmlOptions = {
  /** One sheet name, or omit for all visible worksheets. */
  sheet?: string
  locale?: SheetLocale
  /** Optional overrides applied at render time without mutating the workbook. */
  orientation?: PageOrientation
  paperSize?: PaperSize
  fitToWidth?: number | null
  printGridlines?: boolean
  printHeadings?: boolean
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Renders one sheet or all visible worksheets into a print-ready HTML document. */
export function renderWorkbookHtml(
  ed: SheetEditor,
  opts: RenderHtmlOptions = {},
): { html: string; sheets: string[]; orientation: PageOrientation; paperSize: PaperSize } {
  const locale = opts.locale ?? 'en'
  const wb = ed.wb
  const targets = opts.sheet
    ? [wb.requireWorksheet(opts.sheet)]
    : wb.sheets().filter((s) => s.kind === 'worksheet' && s.state === 'visible')
  if (targets.length === 0) throw new XlsxError('This workbook has no visible worksheets to print.')

  const calc = ed.calc()
  const styles = wb.styles()
  const plain = styles.xf(0)
  const firstSetup = pageSetupOf(wb, targets[0]!.name)
  const orientation = opts.orientation ?? firstSetup.orientation
  const paperSize = opts.paperSize ?? firstSetup.paperSize
  const paper = PAPER_INCHES[paperSize]
  const pageRule = `@page { size: ${paper.css} ${orientation}; margin: ${firstSetup.margins.top}in ${firstSetup.margins.right}in ${firstSetup.margins.bottom}in ${firstSetup.margins.left}in; }`

  const sections: string[] = []
  for (const info of targets) {
    const setup = pageSetupOf(wb, info.name)
    const data = wb.sheet(info.name)
    const rich = richCells(wb, info.name)
    const ori = opts.orientation ?? setup.orientation
    const ps = opts.paperSize ?? setup.paperSize
    const pDim = PAPER_INCHES[ps]
    const pageWidthIn =
      (ori === 'landscape' ? pDim.h : pDim.w) - setup.margins.left - setup.margins.right
    const printablePx = Math.max(200, pageWidthIn * 96)

    const area: Range | null = setup.printArea
      ? parseRange(setup.printArea)
      : data.maxRow >= 0 && data.maxCol >= 0
        ? { top: 0, left: 0, bottom: data.maxRow, right: data.maxCol }
        : null

    if (!area) {
      sections.push(
        `<section class="sheet"><p class="empty">${esc(info.name)} (empty)</p></section>`,
      )
      continue
    }

    const repeatRowRange = setup.repeatRows ? normalizeRepeatRows(setup.repeatRows) : null
    const gridlines = opts.printGridlines ?? setup.printGridlines
    const headings = opts.printHeadings ?? setup.printHeadings
    const fitW = opts.fitToWidth !== undefined ? opts.fitToWidth : setup.fitToWidth

    const colList: number[] = []
    for (let c = area.left; c <= area.right; c++) {
      const ci = data.cols.find((x) => c >= x.min && c <= x.max)
      if (ci?.hidden) continue
      colList.push(c)
    }
    const rowList: number[] = []
    for (let r = area.top; r <= area.bottom; r++) {
      if (data.rows.get(r)?.hidden) continue
      rowList.push(r)
    }
    const headRows: number[] = []
    const bodyRows: number[] = []
    for (const r of rowList) {
      if (repeatRowRange && r >= repeatRowRange.from && r <= repeatRowRange.to) headRows.push(r)
      else bodyRows.push(r)
    }

    const colWidths = colList.map(
      (c) => data.cols.find((x) => c >= x.min && c <= x.max)?.widthPx ?? data.defaultColPx,
    )
    const tablePx = (headings ? 40 : 0) + colWidths.reduce((s, w) => s + w, 0)
    const scaleRatio =
      fitW === 1 && tablePx > printablePx
        ? printablePx / tablePx
        : setup.scale !== 100 && fitW === null
          ? setup.scale / 100
          : 1

    const mergeStart = new Map<number, Range>()
    const mergeCovered = new Set<number>()
    for (const m of data.merges) {
      if (m.top < area.top || m.bottom > area.bottom || m.left < area.left || m.right > area.right)
        continue
      mergeStart.set(cellKey(m.top, m.left), m)
      for (let r = m.top; r <= m.bottom; r++)
        for (let c = m.left; c <= m.right; c++)
          if (r !== m.top || c !== m.left) mergeCovered.add(cellKey(r, c))
    }

    const bordersAt = (r: number, c: number) => {
      const x = data.cells.get(cellKey(r, c))
      return x ? styles.xf(x.style).border : null
    }

    const renderRow = (r: number) => {
      const h = data.rows.get(r)?.heightPx ?? data.defaultRowPx
      const tds: string[] = []
      if (headings) tds.push(`<th class="rh">${r + 1}</th>`)
      for (const c of colList) {
        const k = cellKey(r, c)
        if (mergeCovered.has(k)) continue
        const m = mergeStart.get(k)
        const cell = data.cells.get(k)
        const out = calc.cell(info.name, r, c)
        const st = styles.xf(cell?.style ?? 0)
        const shown = displayValue(out.value, formatCode(st.numFmtId, st.numFmt, locale), locale, {
          date1904: wb.date1904,
        })
        const v = out.value
        const natural =
          typeof v === 'number'
            ? 'right'
            : typeof v === 'boolean' || (typeof v === 'object' && v !== null)
              ? 'center'
              : 'left'
        const align =
          st.horizontal === 'center' || st.horizontal === 'centerContinuous'
            ? 'center'
            : st.horizontal === 'right'
              ? 'right'
              : st.horizontal === 'left'
                ? 'left'
                : natural
        const css: string[] = [
          `text-align:${align}`,
          `vertical-align:${verticalOf(st) === 'center' ? 'middle' : verticalOf(st)}`,
        ]
        if (st.font.bold) css.push('font-weight:600')
        if (st.font.italic) css.push('font-style:italic')
        const deco = [st.font.underline ? 'underline' : '', st.font.strike ? 'line-through' : '']
          .filter(Boolean)
          .join(' ')
        if (deco) css.push(`text-decoration:${deco}`)
        const color = shown.color ?? st.font.color
        if (color) css.push(`color:${color}`)
        if (st.fill) css.push(`background-color:${st.fill}`)
        if (st.font.sizePt && st.font.sizePt !== 11) css.push(`font-size:${st.font.sizePt}pt`)
        if (st.wrap) css.push('white-space:pre-wrap;word-break:break-word')
        const ff = fontFamilyCss(st, plain)
        if (ff) css.push(ff)
        css.push(
          ...borderCss(st.border, {
            right: bordersAt(r, c + 1),
            below: bordersAt(r + 1, c),
            firstCol: c === area.left,
            firstRow: r === area.top,
            filled: !!st.fill,
          }),
        )
        const runs = rich.get(k)
        const inner = runs?.length
          ? runs
              .map((rn) => {
                const rc = runCss(rn)
                return rc ? `<span style="${esc(rc)}">${esc(rn.text)}</span>` : esc(rn.text)
              })
              .join('')
          : esc(shown.text)
        const attrs = [
          m && m.right > m.left
            ? `colspan="${colList.filter((x) => x >= m.left && x <= m.right).length}"`
            : '',
          m && m.bottom > m.top
            ? `rowspan="${rowList.filter((x) => x >= m.top && x <= m.bottom).length}"`
            : '',
          `style="${esc(css.join(';'))}"`,
        ]
          .filter(Boolean)
          .join(' ')
        tds.push(`<td ${attrs}>${inner}</td>`)
      }
      return `<tr style="height:${h}px">${tds.join('')}</tr>`
    }

    const colTags = [
      headings ? '<col style="width:40px">' : '',
      ...colWidths.map((w) => `<col style="width:${w}px">`),
    ].join('')
    const colHeadRow = headings
      ? `<tr><th class="rh"></th>${colList.map((c) => `<th class="ch">${colName(c)}</th>`).join('')}</tr>`
      : ''
    const thead =
      colHeadRow || headRows.length > 0
        ? `<thead>${colHeadRow}${headRows.map(renderRow).join('')}</thead>`
        : ''
    const tbody = `<tbody>${bodyRows.map(renderRow).join('')}</tbody>`
    const zoomStyle = scaleRatio !== 1 ? ` style="zoom:${scaleRatio.toFixed(4)}"` : ''
    const classes = [
      'sheet',
      gridlines ? 'gridlines' : '',
      setup.centerHorizontally ? 'center-h' : '',
    ]
      .filter(Boolean)
      .join(' ')
    sections.push(
      `<section class="${classes}" data-sheet="${esc(info.name)}"><div class="wrap"${zoomStyle}><table style="width:${tablePx}px"><colgroup>${colTags}</colgroup>${thead}${tbody}</table></div></section>`,
    )
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
${pageRule}
* { box-sizing: border-box; }
body { margin: 0; font-family: Calibri, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 11pt; color: #111; }
.sheet { page-break-after: always; }
.sheet:last-child { page-break-after: auto; }
.sheet.center-h .wrap { display: flex; justify-content: center; }
table { border-collapse: collapse; table-layout: fixed; }
td, th { padding: 1px 4px; overflow: hidden; white-space: pre; line-height: 18px; }
.gridlines td { border: 1px solid #d4d4d8; }
th.ch, th.rh { background: #f4f4f5; color: #52525b; font-weight: 500; font-size: 9pt; border: 1px solid #d4d4d8; text-align: center; }
.empty { color: #71717a; font-style: italic; }
</style>
</head>
<body>${sections.join('')}</body>
</html>`

  return {
    html,
    sheets: targets.map((s) => s.name),
    orientation,
    paperSize,
  }
}
