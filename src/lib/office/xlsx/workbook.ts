import { XMLSerializer, type Node as XmldomNode } from '@xmldom/xmldom'
import { strToU8 } from 'fflate'
import { readPackage, REL_OFFICE_DOCUMENT, relsPartOf, type OpcPackage } from '../ooxml/package'
import { dynamicArrayCms } from './metadata'
import { cellKey, cellName, parseCell, parseRange, type Range } from './ref'
import { translateFormula } from './shift'
import { readStyles, type Styles } from './styles'
import {
  CT_SST,
  kid,
  kids,
  NS_MAIN,
  NS_R,
  NS_STRICT,
  REL_CHARTSHEET,
  REL_DIALOGSHEET,
  REL_MACROSHEET,
  REL_SST,
  REL_STYLES,
  REL_THEME,
  REL_WORKSHEET,
  textOf,
} from './xml'

/**
 * An Excel workbook (.xlsx, SpreadsheetML: ECMA-376 Part 1 §18) opened on
 * the lossless OPC layer (../ooxml/package.ts). Reading builds plain models
 * of the sheets; writing edits the parts' XML in place, so everything this
 * editor does not model (charts, pivot tables, comments, styles of untouched
 * cells, other sheets) is written back exactly as it was.
 *
 * Every change runs in a transaction (`begin`/`end`) that records the parts
 * it touched before and after: the editor's undo/redo replays those images.
 */

export type ErrorValue = { error: string }
export type CellValue = number | string | boolean | ErrorValue | null

/** The error values a cell can hold (ECMA-376 Part 1 §18.17.4.3, plus the dynamic-array ones Excel writes). */
export const ERROR_CODES = [
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#GETTING_DATA',
  '#SPILL!',
  '#CALC!',
  '#FIELD!',
  '#BLOCKED!',
  '#CONNECT!',
  '#BUSY!',
  '#UNKNOWN!',
] as const

export const isErrorValue = (v: unknown): v is ErrorValue =>
  typeof v === 'object' && v !== null && typeof (v as ErrorValue).error === 'string'

/** A workbook this editor refuses (not SpreadsheetML, Strict, broken): the message says why. */
export class XlsxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XlsxError'
  }
}

export type SheetKind = 'worksheet' | 'chartsheet' | 'dialogsheet' | 'macrosheet'
export type SheetState = 'visible' | 'hidden' | 'veryHidden'

export type SheetInfo = {
  name: string
  /** Position among the workbook's sheets (tab order). */
  index: number
  sheetId: number
  relId: string
  part: string
  kind: SheetKind
  state: SheetState
}

export type FormulaType = 'normal' | 'shared' | 'array' | 'dataTable'

export type CellData = {
  row: number
  col: number
  /** A literal, or the result a formula had when the file was last calculated. */
  value: CellValue
  /** The formula as the file writes it (no leading "="); shared formulas expanded for this cell. */
  formula: string | null
  formulaType: FormulaType | null
  /** Array and data-table formulas: the cells the formula fills (on its top-left cell). */
  formulaRef: Range | null
  /** Inside another cell's array/data-table range (its value comes from there). */
  inArrayOf: Range | null
  /** An array formula that is a dynamic array (Excel 365, spills) rather than a legacy Ctrl+Shift+Enter one. */
  dynamic: boolean
  /** Index into the style table (cellXfs). */
  style: number
  /** Rich text in the file (several formatted runs): rewritten as plain text when edited. */
  rich: boolean
}

export type ColInfo = {
  min: number
  max: number
  widthPx: number | null
  hidden: boolean
  style: number | null
}
export type RowInfo = { heightPx: number | null; hidden: boolean; style: number | null }

export type SheetData = {
  info: SheetInfo
  cells: Map<number, CellData>
  /** The used extent (-1 when the sheet is empty). */
  maxRow: number
  maxCol: number
  cols: ColInfo[]
  rows: Map<number, RowInfo>
  defaultColPx: number
  defaultRowPx: number
  merges: Range[]
}

export type DefinedName = {
  name: string
  localSheet: number | null
  formula: string
  hidden: boolean
}

type PartImage = { exists: false } | { exists: true; bytes: Uint8Array; contentType: string }
export type Images = Map<string, PartImage>

const SHEET_REL_KIND: Record<string, SheetKind> = {
  [REL_WORKSHEET]: 'worksheet',
  [REL_CHARTSHEET]: 'chartsheet',
  [REL_DIALOGSHEET]: 'dialogsheet',
  [REL_MACROSHEET]: 'macrosheet',
}

/** Excel's default column: 8.43 characters of the default font (64 px); rows 15 pt (20 px). */
export const DEFAULT_COL_PX = 64
export const DEFAULT_ROW_PX = 20

/** Column width in characters (§18.3.1.13) → pixels at the 7 px maximum digit width of Calibri 11. */
export const widthToPx = (w: number) => Math.round(w * 7 + 5)
export const pxToWidth = (px: number) => Math.round(((px - 5) / 7) * 256) / 256
const ptToPx = (pt: number) => Math.round((pt * 4) / 3)

export class Workbook {
  readonly pkg: OpcPackage
  readonly part: string
  private sheetCache = new Map<string, SheetData>()
  private infoCache: SheetInfo[] | null = null
  private stylesCache: Styles | null = null
  private sstCache: string[] | null = null
  private namesCache: DefinedName[] | null = null
  private daCache: Set<number> | null = null
  /** The pre-images of the open transaction (null: none open). */
  private before: Images | null = null
  private dirtyDocs = new Set<string>()

  constructor(pkg: OpcPackage) {
    this.pkg = pkg
    let part: string
    try {
      part = pkg.mainPart(REL_OFFICE_DOCUMENT)
    } catch {
      throw new XlsxError('This is not an Excel workbook: the package has no main document.')
    }
    const root = pkg.xml(part).documentElement!
    if (root.namespaceURI === NS_STRICT)
      throw new XlsxError(
        'This workbook is saved as “Strict Open XML”, which this editor does not open yet. Save it as a normal Excel workbook (.xlsx).',
      )
    if (root.namespaceURI !== NS_MAIN || root.localName !== 'workbook')
      throw new XlsxError(
        'This is not an Excel workbook: its main part is not a SpreadsheetML workbook.',
      )
    this.part = part
  }

  get date1904(): boolean {
    const pr = kid(this.pkg.xml(this.part).documentElement!, 'workbookPr')
    const v = pr?.getAttribute('date1904')
    return v === '1' || v === 'true'
  }

  // ---------------------------------------------------------------------------
  // Reading

  sheets(): SheetInfo[] {
    if (this.infoCache) return this.infoCache
    const root = this.pkg.xml(this.part).documentElement!
    const rels = new Map(this.pkg.relationships(this.part).map((r) => [r.id, r]))
    const sheetsEl = kid(root, 'sheets')
    const out: SheetInfo[] = []
    for (const el of sheetsEl ? kids(sheetsEl, 'sheet') : []) {
      const relId = el.getAttributeNS(NS_R, 'id') ?? ''
      const rel = rels.get(relId)
      if (!rel?.part)
        throw new XlsxError(
          `The sheet “${el.getAttribute('name')}” points at a part the workbook does not have.`,
        )
      const kind = SHEET_REL_KIND[rel.type]
      if (!kind)
        throw new XlsxError(
          `The sheet “${el.getAttribute('name')}” is of an unknown kind (${rel.type}).`,
        )
      const state = el.getAttribute('state')
      out.push({
        name: el.getAttribute('name') ?? '',
        index: out.length,
        sheetId: Number(el.getAttribute('sheetId') ?? 0),
        relId,
        part: rel.part,
        kind,
        state: state === 'hidden' || state === 'veryHidden' ? state : 'visible',
      })
    }
    if (out.length === 0) throw new XlsxError('This workbook has no sheets.')
    this.infoCache = out
    return out
  }

  /** The sheet called `name` (case-insensitive, as Excel compares sheet names), else null. */
  findSheet(name: string): SheetInfo | null {
    const k = name.toLowerCase()
    return this.sheets().find((s) => s.name.toLowerCase() === k) ?? null
  }

  requireSheet(name: string): SheetInfo {
    const s = this.findSheet(name)
    if (!s)
      throw new XlsxError(
        `This workbook has no sheet called “${name}” (it has ${this.sheets()
          .map((x) => `“${x.name}”`)
          .join(', ')}).`,
      )
    return s
  }

  requireWorksheet(name: string): SheetInfo {
    const s = this.requireSheet(name)
    if (s.kind !== 'worksheet')
      throw new XlsxError(
        `“${s.name}” is a ${s.kind === 'chartsheet' ? 'chart sheet' : s.kind}, not a sheet of cells.`,
      )
    return s
  }

  styles(): Styles {
    if (this.stylesCache) return this.stylesCache
    const rel = this.pkg.relationships(this.part).find((r) => r.type === REL_STYLES && r.part)
    const theme = this.pkg.relationships(this.part).find((r) => r.type === REL_THEME && r.part)
    this.stylesCache = readStyles(
      rel && this.pkg.has(rel.part!) ? this.pkg.xml(rel.part!) : null,
      theme && this.pkg.has(theme.part!) ? this.pkg.xml(theme.part!) : null,
    )
    return this.stylesCache
  }

  stylesPart(): string | null {
    const rel = this.pkg.relationships(this.part).find((r) => r.type === REL_STYLES && r.part)
    return rel?.part && this.pkg.has(rel.part) ? rel.part : null
  }

  sstPart(): string | null {
    const rel = this.pkg.relationships(this.part).find((r) => r.type === REL_SST && r.part)
    return rel?.part && this.pkg.has(rel.part) ? rel.part : null
  }

  sharedStrings(): string[] {
    if (this.sstCache) return this.sstCache
    const part = this.sstPart()
    this.sstCache = part ? kids(this.pkg.xml(part).documentElement!, 'si').map(stringItemText) : []
    return this.sstCache
  }

  definedNames(): DefinedName[] {
    if (this.namesCache) return this.namesCache
    const el = kid(this.pkg.xml(this.part).documentElement!, 'definedNames')
    this.namesCache = (el ? kids(el, 'definedName') : []).map((d) => {
      const local = d.getAttribute('localSheetId')
      return {
        name: d.getAttribute('name') ?? '',
        localSheet: local === null ? null : Number(local),
        formula: textOf(d),
        hidden: d.getAttribute('hidden') === '1' || d.getAttribute('hidden') === 'true',
      }
    })
    return this.namesCache
  }

  /** The `cm` values that mark dynamic-array formulas (metadata.ts). */
  dynamicArrayCms(): Set<number> {
    this.daCache ??= dynamicArrayCms(this.pkg, this.part)
    return this.daCache
  }

  /** The metadata part changed (within a transaction): cell models are rebuilt. */
  forgetMetadata() {
    this.daCache = null
    this.sheetCache.clear()
  }

  /** The cells and layout of a worksheet (cached until the sheet changes). */
  sheet(name: string): SheetData {
    const info = this.requireWorksheet(name)
    const hit = this.sheetCache.get(info.part)
    if (hit) return hit
    const data = this.readSheet(info)
    this.sheetCache.set(info.part, data)
    return data
  }

  private readSheet(info: SheetInfo): SheetData {
    const root = this.pkg.xml(info.part).documentElement!
    const sst = this.sharedStrings()
    const daCms = this.dynamicArrayCms()
    const cells = new Map<number, CellData>()
    let maxRow = -1
    let maxCol = -1
    const rows = new Map<number, RowInfo>()
    const shared = new Map<string, { anchor: string; text: string }>()
    const sharedKids: CellData[] = []
    const sharedSi = new Map<CellData, string>()
    const arrays: Range[] = []
    const sheetData = kid(root, 'sheetData')
    let r = -1
    for (const rowEl of sheetData ? kids(sheetData, 'row') : []) {
      const rAttr = rowEl.getAttribute('r')
      r = rAttr ? Number(rAttr) - 1 : r + 1
      const ht = rowEl.getAttribute('ht')
      const hidden = rowEl.getAttribute('hidden') === '1' || rowEl.getAttribute('hidden') === 'true'
      const rowStyle =
        rowEl.getAttribute('customFormat') === '1' ? Number(rowEl.getAttribute('s') ?? 0) : null
      if (ht || hidden || rowStyle !== null)
        rows.set(r, { heightPx: ht ? ptToPx(Number(ht)) : null, hidden, style: rowStyle })
      let c = -1
      for (const cEl of kids(rowEl, 'c')) {
        const ref = cEl.getAttribute('r')
        const addr = ref ? parseCell(ref) : null
        c = addr ? addr.col : c + 1
        const row = addr ? addr.row : r
        const cell = readCell(cEl, row, c, sst)
        if (cell.formulaType === 'array' && daCms.has(Number(cEl.getAttribute('cm'))))
          cell.dynamic = true
        const f = kid(cEl, 'f')
        if (f) {
          const t = f.getAttribute('t')
          if (t === 'shared') {
            const si = f.getAttribute('si') ?? ''
            const text = textOf(f)
            if (f.getAttribute('ref') !== null && text !== '')
              shared.set(si, { anchor: cellName({ row, col: c }), text })
            else {
              sharedKids.push(cell)
              sharedSi.set(cell, si)
            }
          }
          if ((t === 'array' || t === 'dataTable') && cell.formulaRef) arrays.push(cell.formulaRef)
        }
        if (cell.value === null && cell.formulaType === null && cell.style === 0) continue
        cells.set(cellKey(row, c), cell)
        if (cell.value !== null || cell.formulaType !== null) {
          if (row > maxRow) maxRow = row
          if (c > maxCol) maxCol = c
        }
      }
    }
    for (const cell of sharedKids) {
      const g = shared.get(sharedSi.get(cell)!)
      if (!g)
        throw new XlsxError(
          `${info.name}!${cellName(cell)} uses a shared formula the sheet does not define.`,
        )
      cell.formula = translateFormula(g.text, g.anchor, cellName(cell))
    }
    for (const range of arrays) {
      for (const cell of cells.values()) {
        if (cell.formulaRef) continue
        if (
          cell.row >= range.top &&
          cell.row <= range.bottom &&
          cell.col >= range.left &&
          cell.col <= range.right
        )
          cell.inArrayOf = range
      }
    }
    const fmt = kid(root, 'sheetFormatPr')
    const defW = fmt?.getAttribute('defaultColWidth')
    const baseW = fmt?.getAttribute('baseColWidth')
    const defH = fmt?.getAttribute('defaultRowHeight')
    const colsEl = kid(root, 'cols')
    const cols: ColInfo[] = (colsEl ? kids(colsEl, 'col') : []).map((el) => {
      const w = el.getAttribute('width')
      const s = el.getAttribute('style')
      return {
        min: Number(el.getAttribute('min')) - 1,
        max: Number(el.getAttribute('max')) - 1,
        widthPx: w !== null ? widthToPx(Number(w)) : null,
        hidden: el.getAttribute('hidden') === '1' || el.getAttribute('hidden') === 'true',
        style: s !== null ? Number(s) : null,
      }
    })
    const mergeEl = kid(root, 'mergeCells')
    const merges = (mergeEl ? kids(mergeEl, 'mergeCell') : []).flatMap((m) => {
      const range = parseRange(m.getAttribute('ref') ?? '')
      return range ? [range] : []
    })
    return {
      info,
      cells,
      maxRow,
      maxCol,
      cols,
      rows,
      defaultColPx: defW
        ? widthToPx(Number(defW))
        : baseW
          ? widthToPx(Number(baseW) + 0.71)
          : DEFAULT_COL_PX,
      defaultRowPx: defH ? ptToPx(Number(defH)) : DEFAULT_ROW_PX,
      merges,
    }
  }

  // ---------------------------------------------------------------------------
  // Writing: transactions over parts

  /** Opens a transaction: every part touched from now on is recorded before its first change. */
  begin() {
    if (this.before) throw new Error('xlsx: a transaction is already open')
    this.before = new Map()
    this.dirtyDocs.clear()
  }

  /** Records `part` before its first change in this transaction. */
  touch(part: string) {
    if (!this.before) throw new Error('xlsx: change outside a transaction')
    if (this.before.has(part)) return
    this.before.set(part, this.imageOf(part))
  }

  /** The part's XML for changing (recorded, and serialized back at `end`). */
  edit(part: string): XMLDocument {
    this.touch(part)
    this.dirtyDocs.add(part)
    return this.pkg.xml(part)
  }

  /** A new part (or new bytes for one), recorded like an edit. */
  write(part: string, bytes: Uint8Array, contentType?: string) {
    this.touch(part)
    this.dirtyDocs.delete(part)
    this.pkg.setBytes(part, bytes, this.pkg.has(part) ? undefined : contentType)
  }

  remove(part: string) {
    if (!this.pkg.has(part)) return
    this.touch(part)
    this.dirtyDocs.delete(part)
    this.pkg.remove(part)
  }

  /** Closes the transaction: the parts as they were before and as they are now. */
  end(): { before: Images; after: Images } {
    const before = this.before
    if (!before) throw new Error('xlsx: no transaction is open')
    for (const part of this.dirtyDocs)
      if (this.pkg.has(part)) this.pkg.setXml(part, this.pkg.xml(part))
    this.dirtyDocs.clear()
    this.before = null
    const after: Images = new Map()
    for (const part of before.keys()) after.set(part, this.imageOf(part))
    this.invalidate()
    return { before, after }
  }

  /** Abandons the open transaction: the touched parts go back to how they were. */
  abort() {
    const before = this.before
    this.before = null
    this.dirtyDocs.clear()
    if (before) this.restore(before)
  }

  /** Puts parts back to recorded images (undo/redo). */
  restore(images: Images) {
    for (const [part, img] of images) {
      if (!img.exists) {
        if (this.pkg.has(part)) this.pkg.remove(part)
      } else this.pkg.setBytes(part, img.bytes, this.pkg.has(part) ? undefined : img.contentType)
    }
    this.invalidate()
  }

  private imageOf(part: string): PartImage {
    if (!this.pkg.has(part)) return { exists: false }
    const bytes = this.dirtyDocs.has(part)
      ? strToU8(serializeDoc(this.pkg.xml(part)))
      : this.pkg.bytes(part)
    return { exists: true, bytes, contentType: this.pkg.contentType(part) }
  }

  /** Drops every cached model (after a change or undo). */
  invalidate() {
    this.sheetCache.clear()
    this.infoCache = null
    this.stylesCache = null
    this.sstCache = null
    this.namesCache = null
    this.daCache = null
  }

  /** The shared-string index of `text` (a plain entry; added when it is new). */
  sharedStringIndex(text: string): number {
    let part = this.sstPart()
    if (!part) {
      part = '/xl/sharedStrings.xml'
      for (let n = 2; this.pkg.has(part); n++) part = `/xl/sharedStrings${n}.xml`
      this.write(
        part,
        strToU8(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS_MAIN}" count="0" uniqueCount="0"/>`,
        ),
        CT_SST,
      )
      this.touch(relsPartOf(this.part))
      this.pkg.addRelationship(this.part, REL_SST, relativeTarget(this.part, part))
    }
    const doc = this.edit(part)
    const root = doc.documentElement!
    const items = kids(root, 'si')
    for (let i = 0; i < items.length; i++) {
      const si = items[i]!
      if (kids(si, 'r').length === 0 && kid(si, 't') && textOf(kid(si, 't')) === text) return i
    }
    const si = doc.createElementNS(NS_MAIN, root.prefix ? `${root.prefix}:si` : 'si')
    const t = doc.createElementNS(NS_MAIN, root.prefix ? `${root.prefix}:t` : 't')
    t.appendChild(doc.createTextNode(text))
    if (/^\s|\s$|\n/.test(text))
      t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
    si.appendChild(t)
    root.appendChild(si)
    root.setAttribute('uniqueCount', String(items.length + 1))
    root.setAttribute('count', String(Number(root.getAttribute('count') ?? items.length) + 1))
    this.sstCache = null
    return items.length
  }

  /** Sheet models are rebuilt after a change; within a transaction call this after editing a sheet's XML. */
  forgetSheet(part: string) {
    this.sheetCache.delete(part)
    this.infoCache = null
    this.namesCache = null
  }
}

export function openWorkbook(bytes: Uint8Array): Workbook {
  return new Workbook(readPackage(bytes))
}

/** Same serializer as the package (xmldom): the image of a part changed in place. */
const serializeDoc = (doc: XMLDocument) =>
  new XMLSerializer().serializeToString(doc as unknown as XmldomNode)

/** A relationship target from `source`'s folder to `part` (both absolute part names). */
export function relativeTarget(source: string, part: string): string {
  const from = source.split('/').slice(1, -1)
  const to = part.split('/').slice(1)
  let i = 0
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/')
}

/** The text of a shared-string item or inline string: plain `<t>`, or the runs' text (phonetic runs left out). */
export function stringItemText(si: Element): string {
  const t = kid(si, 't')
  const runs = kids(si, 'r')
  if (runs.length === 0) return textOf(t)
  return runs.map((r) => textOf(kid(r, 't'))).join('')
}

function readCell(cEl: Element, row: number, col: number, sst: string[]): CellData {
  const t = cEl.getAttribute('t') ?? 'n'
  const vEl = kid(cEl, 'v')
  const v = vEl ? textOf(vEl) : null
  const f = kid(cEl, 'f')
  let value: CellValue = null
  let rich = false
  if (t === 's') {
    if (v !== null) {
      const i = Number(v)
      if (!Number.isInteger(i) || i < 0 || i >= sst.length)
        throw new XlsxError(
          `Cell ${cellName({ row, col })} points at shared string ${v}, which the workbook does not have.`,
        )
      value = sst[i]!
    }
  } else if (t === 'inlineStr') {
    const is = kid(cEl, 'is')
    value = is ? stringItemText(is) : ''
    rich = !!is && kids(is, 'r').length > 0
  } else if (t === 'str') value = v ?? ''
  else if (t === 'b') value = v === null ? null : v === '1' || v === 'true'
  else if (t === 'e') value = v === null ? null : { error: v }
  else if (t === 'd') value = v === null ? null : isoToSerial(v)
  else if (v !== null && v !== '') {
    const n = Number(v)
    if (!Number.isFinite(n))
      throw new XlsxError(`Cell ${cellName({ row, col })} holds “${v}”, which is not a number.`)
    value = n
  }
  const ft = f?.getAttribute('t') as FormulaType | null
  const formulaType: FormulaType | null = f
    ? ft === 'shared' || ft === 'array' || ft === 'dataTable'
      ? ft
      : 'normal'
    : null
  const fRef = f?.getAttribute('ref')
  return {
    row,
    col,
    value,
    formula: f && textOf(f) !== '' ? textOf(f) : null,
    formulaType,
    formulaRef:
      (formulaType === 'array' || formulaType === 'dataTable') && fRef ? parseRange(fRef) : null,
    inArrayOf: null,
    dynamic: false,
    style: Number(cEl.getAttribute('s') ?? 0),
    rich,
  }
}

/** An ISO 8601 date/time (cell type "d") → an Excel serial number (1900 date system). */
function isoToSerial(iso: string): number {
  const ms = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`)
  if (Number.isNaN(ms)) throw new XlsxError(`“${iso}” is not a date.`)
  return ms / 86_400_000 + 25_569
}
