import { finishSheet, restyle, sheetDoc, stylesDoc } from './ops'
import { cellKey, cellName, rangeName, requireRange, type Range } from './ref'
import { SHEET_ALLOW, type SheetAllow } from './rules-choices'
import { sha512 } from './sha512'
import { WORKSHEET_ORDER } from './sheet-order'
import { parseSqref } from './sqref'
import { deepSignature } from './style-records'
import { ensureCellXfs } from './styles'
import { XlsxError, type Workbook } from './workbook'
import { insertInOrder, kid, kids, make, WORKBOOK_ORDER } from './xml'

export { SHEET_ALLOW }
export type { SheetAllow }

/**
 * Sheet and workbook protection (ECMA-376 Part 1 §18.3.1.85 sheetProtection,
 * §18.2.29 workbookProtection, §18.8.33 protection of a cell format) as
 * Excel honours it: on a protected sheet a locked cell (every cell, unless
 * its format says `locked="0"`) can't be changed, and each action the sheet
 * protection doesn't allow (formatting, inserting or deleting rows, sorting
 * …) is refused with the reason; a workbook with a locked structure refuses
 * adding, renaming and deleting sheets. Every refusal comes from `guard`,
 * which every operation passes before it runs (./ops.ts).
 *
 * Passwords are hashed as Excel 2013+ writes them — SHA-512 over a random
 * 16-byte salt and the password in UTF-16LE, re-hashed `spinCount` times with
 * the iteration number appended (little-endian), base64 — and the 16-bit
 * legacy hash of older files (`password="CBEB"`) is checked when that is all
 * a file has. A password is never stored, logged or returned: only its hash
 * lands in the file.
 */

/**
 * The schema's defaults: `true` on an attribute means the action is
 * *protected* (not allowed) — except the two selections, which default to
 * allowed (false = not protected).
 */
const PROTECTED_BY_DEFAULT: Record<SheetAllow, boolean> = {
  selectLockedCells: false,
  selectUnlockedCells: false,
  formatCells: true,
  formatColumns: true,
  formatRows: true,
  insertColumns: true,
  insertRows: true,
  insertHyperlinks: true,
  deleteColumns: true,
  deleteRows: true,
  sort: true,
  autoFilter: true,
  pivotTables: true,
  objects: false,
  scenarios: false,
}

export type SheetProtection = {
  /** Allowed actions (true: people may do it on the protected sheet). */
  allow: Record<SheetAllow, boolean>
  hasPassword: boolean
  /** Ranges that stay editable on the protected sheet (Allow Edit Ranges); with a password: not editable here. */
  editRanges: Array<{ name: string; ranges: Range[]; hasPassword: boolean }>
}

export type WorkbookProtection = { structure: boolean; windows: boolean; hasPassword: boolean }

export type ProtectionOp =
  | {
      op: 'protect_sheet'
      sheet: string
      /** null/empty: protected without a password. */
      password?: string | null
      allow?: Partial<Record<SheetAllow, boolean>>
    }
  | { op: 'unprotect_sheet'; sheet: string; password?: string | null }
  | { op: 'protect_workbook'; password?: string | null }
  | { op: 'unprotect_workbook'; password?: string | null }
  /** Format Cells ▸ Protection: locked / hidden on a range (takes effect when the sheet is protected). */
  | { op: 'set_cell_protection'; sheet: string; range: string; locked?: boolean; hidden?: boolean }

const SPIN_COUNT = 100_000
/** A file asking for more spins than this would hang the check; it is refused instead. */
const MAX_SPIN_COUNT = 10_000_000

const truthy = (v: string | null) => v === '1' || v === 'true'
const attrBool = (el: Element, name: string, fallback: boolean) => {
  const v = el.getAttribute(name)
  return v === null ? fallback : truthy(v)
}

// ---------------------------------------------------------------------------
// Hashes

/** The legacy 16-bit password verifier (ECMA-376 Part 4 §14.7.1, `password` attributes), hex as Excel writes it. */
export function legacyPasswordHash(password: string): string {
  let v = 0
  for (let i = password.length - 1; i >= 0; i--) {
    v = (((v >> 14) & 1) | ((v << 1) & 0x7fff)) ^ (password.charCodeAt(i) & 0xff)
  }
  v = (((v >> 14) & 1) | ((v << 1) & 0x7fff)) ^ password.length ^ 0xce4b
  return v.toString(16).toUpperCase().padStart(4, '0')
}

const utf16le = (s: string) => {
  const out = new Uint8Array(s.length * 2)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out[i * 2] = c & 0xff
    out[i * 2 + 1] = c >>> 8
  }
  return out
}

const toB64 = (b: Uint8Array) => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}
const fromB64 = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0))

/** Excel's SHA-512 password hash (base64) for `salt` (base64) and `spinCount`. */
export function sha512PasswordHash(password: string, saltB64: string, spinCount: number): string {
  const salt = fromB64(saltB64)
  const pw = utf16le(password)
  const first = new Uint8Array(salt.length + pw.length)
  first.set(salt)
  first.set(pw, salt.length)
  let h = sha512(first)
  const buf = new Uint8Array(68)
  for (let i = 0; i < spinCount; i++) {
    buf.set(h)
    buf[64] = i & 0xff
    buf[65] = (i >>> 8) & 0xff
    buf[66] = (i >>> 16) & 0xff
    buf[67] = (i >>> 24) & 0xff
    h = sha512(buf)
  }
  return toB64(h)
}

type HashAttrs = { algorithm: string; hash: string; salt: string; spin: string; legacy: string }
const SHEET_ATTRS: HashAttrs = {
  algorithm: 'algorithmName',
  hash: 'hashValue',
  salt: 'saltValue',
  spin: 'spinCount',
  legacy: 'password',
}
const BOOK_ATTRS: HashAttrs = {
  algorithm: 'workbookAlgorithmName',
  hash: 'workbookHashValue',
  salt: 'workbookSaltValue',
  spin: 'workbookSpinCount',
  legacy: 'workbookPassword',
}

const hasPasswordOn = (el: Element, a: HashAttrs) =>
  !!el.getAttribute(a.hash) || !!el.getAttribute(a.legacy)

/** Whether `password` opens the protection on `el` (true when it has no password). */
function passwordMatches(el: Element, a: HashAttrs, password: string): boolean {
  const hash = el.getAttribute(a.hash)
  if (hash) {
    const algo = (el.getAttribute(a.algorithm) ?? '').toUpperCase()
    if (algo !== 'SHA-512')
      throw new XlsxError(
        `This protection is hashed with ${algo || 'an unnamed algorithm'}, which this editor can't check; remove it in Excel.`,
      )
    const spin = Number(el.getAttribute(a.spin) ?? 0)
    if (!Number.isInteger(spin) || spin < 0 || spin > MAX_SPIN_COUNT)
      throw new XlsxError(
        `This protection's spin count (${el.getAttribute(a.spin)}) is not one Excel writes.`,
      )
    return sha512PasswordHash(password, el.getAttribute(a.salt) ?? '', spin) === hash
  }
  const legacy = el.getAttribute(a.legacy)
  if (legacy) return legacyPasswordHash(password) === legacy.toUpperCase().padStart(4, '0')
  return true
}

function writePassword(el: Element, a: HashAttrs, password: string | null | undefined) {
  for (const k of [a.algorithm, a.hash, a.salt, a.spin, a.legacy]) el.removeAttribute(k)
  if (!password) return
  if (password.length > 255) throw new XlsxError('A password can have at most 255 characters.')
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const saltB64 = toB64(salt)
  el.setAttribute(a.algorithm, 'SHA-512')
  el.setAttribute(a.hash, sha512PasswordHash(password, saltB64, SPIN_COUNT))
  el.setAttribute(a.salt, saltB64)
  el.setAttribute(a.spin, String(SPIN_COUNT))
}

// ---------------------------------------------------------------------------
// Reading

function protectionEl(wb: Workbook, sheet: string): Element | null {
  const info = wb.requireWorksheet(sheet)
  const el = kid(wb.pkg.xml(info.part).documentElement!, 'sheetProtection')
  return el && truthy(el.getAttribute('sheet')) ? el : null
}

/** The sheet's protection, or null when it isn't protected. */
export function sheetProtectionOf(wb: Workbook, sheet: string): SheetProtection | null {
  const el = protectionEl(wb, sheet)
  if (!el) return null
  const allow = {} as Record<SheetAllow, boolean>
  for (const k of SHEET_ALLOW) allow[k] = !attrBool(el, k, PROTECTED_BY_DEFAULT[k])
  const root = wb.pkg.xml(wb.requireWorksheet(sheet).part).documentElement!
  const pr = kid(root, 'protectedRanges')
  return {
    allow,
    hasPassword: hasPasswordOn(el, SHEET_ATTRS),
    editRanges: (pr ? kids(pr, 'protectedRange') : []).map((p) => ({
      name: p.getAttribute('name') ?? '',
      ranges: parseSqref(p.getAttribute('sqref') ?? ''),
      hasPassword: hasPasswordOn(p, SHEET_ATTRS),
    })),
  }
}

export function workbookProtectionOf(wb: Workbook): WorkbookProtection | null {
  const el = kid(wb.pkg.xml(wb.part).documentElement!, 'workbookProtection')
  if (!el) return null
  const structure = truthy(el.getAttribute('lockStructure'))
  const windows = truthy(el.getAttribute('lockWindows'))
  if (!structure && !windows) return null
  return { structure, windows, hasPassword: hasPasswordOn(el, BOOK_ATTRS) }
}

/** Locked / hidden of each cell format (cellXfs), as §18.8.33 defaults them (locked, not hidden). */
function xfProtection(wb: Workbook): Array<{ locked: boolean; hidden: boolean }> {
  const part = wb.stylesPart()
  const xfsEl = part ? kid(wb.pkg.xml(part).documentElement!, 'cellXfs') : null
  return (xfsEl ? kids(xfsEl, 'xf') : []).map((xf) => {
    const p = kid(xf, 'protection')
    return {
      locked: p ? attrBool(p, 'locked', true) : true,
      hidden: p ? attrBool(p, 'hidden', false) : false,
    }
  })
}

export type CellProtection = { locked: boolean; hidden: boolean }

/** A reader of cells' locked/hidden flags on one sheet (style of the cell, else its row's, else its column's). */
export function cellProtectionReader(
  wb: Workbook,
  sheet: string,
): (row: number, col: number) => CellProtection {
  const flags = xfProtection(wb)
  const data = wb.sheet(sheet)
  return (row, col) => {
    const cell = data.cells.get(cellKey(row, col))
    const style =
      cell?.style ??
      data.rows.get(row)?.style ??
      data.cols.find((c) => col >= c.min && col <= c.max)?.style ??
      0
    return flags[style] ?? { locked: true, hidden: false }
  }
}

// ---------------------------------------------------------------------------
// Guard: what each operation may do on a protected sheet / workbook

/** An operation as the guard sees it (any SheetOp). */
type AnyOp = { op: string; sheet?: string; [k: string]: unknown }

const SHEET_ACTION: Record<
  string,
  { allow?: SheetAllow; never?: true; cells?: (op: AnyOp) => Range[]; what: string }
> = {
  set_cells: { cells: (op) => cellsOf(op), what: 'change locked cells' },
  set_format: { allow: 'formatCells', what: 'format cells' },
  set_style: { allow: 'formatCells', what: 'format cells' },
  set_column_width: { allow: 'formatColumns', what: 'change column widths' },
  set_row_height: { allow: 'formatRows', what: 'change row heights' },
  insert_rows: { allow: 'insertRows', what: 'insert rows' },
  insert_columns: { allow: 'insertColumns', what: 'insert columns' },
  delete_rows: { allow: 'deleteRows', cells: (op) => lines(op, 'rows'), what: 'delete rows' },
  delete_columns: {
    allow: 'deleteColumns',
    cells: (op) => lines(op, 'cols'),
    what: 'delete columns',
  },
  sort_range: { allow: 'sort', cells: (op) => [requireRange(String(op.range))], what: 'sort' },
  set_autofilter: { allow: 'autoFilter', what: 'turn the filter on or off' },
  filter_column: { allow: 'autoFilter', what: 'filter' },
  freeze_panes: { what: '' },
  hyperlink_set: {
    allow: 'insertHyperlinks',
    cells: (op) => [requireRange(String(op.range))],
    what: 'add links',
  },
  hyperlink_remove: { allow: 'insertHyperlinks', what: 'remove links' },
  cf_add: { allow: 'formatCells', what: 'change conditional formatting' },
  cf_update: { allow: 'formatCells', what: 'change conditional formatting' },
  cf_delete: { allow: 'formatCells', what: 'change conditional formatting' },
  cf_clear: { allow: 'formatCells', what: 'change conditional formatting' },
  cf_move: { allow: 'formatCells', what: 'change conditional formatting' },
  validation_set: { allow: 'formatCells', what: 'change data validation' },
  validation_clear: { allow: 'formatCells', what: 'change data validation' },
  set_cell_protection: { allow: 'formatCells', what: 'lock or unlock cells' },
  // Excel tables can't be made, changed or removed on a protected sheet (Excel greys Table Design out).
  create_table: { never: true, what: 'make tables' },
  update_table: { never: true, what: 'change tables' },
  delete_table: { never: true, what: 'remove tables' },
  // PivotTables: only when the protection allows "Use PivotTable & PivotChart".
  create_pivot: { allow: 'pivotTables', what: 'put PivotTables' },
  update_pivot: { allow: 'pivotTables', what: 'change PivotTables' },
  refresh_pivot: { allow: 'pivotTables', what: 'refresh PivotTables' },
  delete_pivot: { allow: 'pivotTables', what: 'remove PivotTables' },
  // Charts are objects: only when the protection allows "Edit objects".
  chart_create: { allow: 'objects', what: 'insert charts' },
  chart_update: { allow: 'objects', what: 'change charts' },
  chart_move: { allow: 'objects', what: 'move charts' },
  chart_delete: { allow: 'objects', what: 'delete charts' },
}

/** Workbook-level operations a locked structure refuses. */
const STRUCTURE_OPS = new Set(['add_sheet', 'rename_sheet', 'delete_sheet'])
/** Never refused by protection: they change protection or nothing on a sheet's cells. */
const FREE_OPS = new Set([
  'protect_sheet',
  'unprotect_sheet',
  'protect_workbook',
  'unprotect_workbook',
  'name_add',
  'name_update',
  'name_delete',
  'freeze_panes',
])

function cellsOf(op: AnyOp): Range[] {
  const cells = op.cells as Array<{ ref: string }> | undefined
  return (cells ?? []).map((c) => requireRange(c.ref))
}

function lines(op: AnyOp, axis: 'rows' | 'cols'): Range[] {
  const at = Number(op.at)
  const count = Number(op.count)
  return axis === 'rows'
    ? [{ top: at, bottom: at + count - 1, left: 0, right: 16_383 }]
    : [{ top: 0, bottom: 1_048_575, left: at, right: at + count - 1 }]
}

/** Throws the reason when protection forbids `op`; does nothing otherwise. */
export function guard(wb: Workbook, op: AnyOp) {
  if (FREE_OPS.has(op.op)) return
  if (STRUCTURE_OPS.has(op.op)) {
    if (workbookProtectionOf(wb)?.structure)
      throw new XlsxError(
        'The workbook’s structure is protected: sheets can’t be added, renamed or deleted. Unprotect the workbook first.',
      )
    return
  }
  // Operations that add a sheet as they go: a new chart sheet, a PivotTable on a new sheet.
  const addsSheet =
    (op.op === 'chart_create' && !!op.newSheet) || (op.op === 'create_pivot' && !op.targetSheet)
  if (addsSheet && workbookProtectionOf(wb)?.structure)
    throw new XlsxError(
      'The workbook’s structure is protected: no sheet can be added for this. Unprotect the workbook first.',
    )
  // A PivotTable lands on its target sheet; a new one is not protected yet.
  const sheetName = op.op === 'create_pivot' ? (op.targetSheet as string | undefined) : op.sheet
  if (!sheetName || (op.op === 'chart_create' && op.newSheet)) return
  const info = wb.findSheet(sheetName)
  if (!info || info.kind !== 'worksheet') return
  const prot = sheetProtectionOf(wb, info.name)
  if (!prot) return
  const action = SHEET_ACTION[op.op]
  const refuse = (what: string) => {
    throw new XlsxError(
      `“${info.name}” is protected: you can’t ${what} there. Unprotect the sheet first${prot.hasPassword ? ' (it has a password)' : ''}.`,
    )
  }
  if (!action) refuse(`make this change (${op.op.replace(/_/g, ' ')})`)
  if (action!.never) refuse(action!.what)
  if (action!.allow && !prot.allow[action!.allow]) refuse(action!.what)
  if (action!.cells) {
    const locked = firstLocked(wb, info.name, action!.cells(op), prot)
    if (locked)
      throw new XlsxError(
        `${info.name}!${locked} is locked and the sheet is protected. Unprotect the sheet first${prot.hasPassword ? ' (it has a password)' : ''}.`,
      )
  }
}

/** The first locked cell in `ranges` (filled cells only for whole rows/columns), or null. */
function firstLocked(
  wb: Workbook,
  sheet: string,
  ranges: Range[],
  prot: SheetProtection,
): string | null {
  const read = cellProtectionReader(wb, sheet)
  const data = wb.sheet(sheet)
  const editable = (r: number, c: number) =>
    prot.editRanges.some(
      (e) =>
        !e.hasPassword &&
        e.ranges.some((x) => r >= x.top && r <= x.bottom && c >= x.left && c <= x.right),
    )
  for (const range of ranges) {
    const n = (range.bottom - range.top + 1) * (range.right - range.left + 1)
    if (n > 200_000) {
      for (const cell of data.cells.values())
        if (
          cell.row >= range.top &&
          cell.row <= range.bottom &&
          cell.col >= range.left &&
          cell.col <= range.right &&
          read(cell.row, cell.col).locked &&
          !editable(cell.row, cell.col)
        )
          return cellName(cell)
      continue
    }
    for (let r = range.top; r <= range.bottom; r++)
      for (let c = range.left; c <= range.right; c++)
        if (read(r, c).locked && !editable(r, c)) return cellName({ row: r, col: c })
  }
  return null
}

// ---------------------------------------------------------------------------
// Writing

export function runProtectionOp(wb: Workbook, op: ProtectionOp): string[] {
  const docOf = (name: string) => sheetDoc(wb, wb.requireWorksheet(name))
  switch (op.op) {
    case 'protect_sheet': {
      const info = wb.requireWorksheet(op.sheet)
      const cur = protectionEl(wb, info.name)
      if (cur && hasPasswordOn(cur, SHEET_ATTRS))
        throw new XlsxError(
          `“${info.name}” is already protected with a password; unprotect it first.`,
        )
      const doc = docOf(info.name)
      const root = doc.documentElement!
      let el = kid(root, 'sheetProtection')
      if (!el) {
        el = make(doc, 'sheetProtection')
        insertInOrder(root, el, WORKSHEET_ORDER)
      }
      for (let i = el.attributes.length - 1; i >= 0; i--) el.removeAttribute(el.attributes[i]!.name)
      writePassword(el, SHEET_ATTRS, op.password)
      el.setAttribute('sheet', '1')
      // Excel protects objects and scenarios with the sheet unless they are allowed.
      const allow = { objects: false, scenarios: false, ...op.allow }
      // In the order Excel writes them: objects, scenarios, then the rest.
      const order = [
        'objects',
        'scenarios',
        ...SHEET_ALLOW.filter((k) => k !== 'objects' && k !== 'scenarios'),
      ] as SheetAllow[]
      for (const k of order) {
        const allowed = allow[k] ?? !PROTECTED_BY_DEFAULT[k]
        const protectedNow = !allowed
        if (protectedNow !== PROTECTED_BY_DEFAULT[k]) el.setAttribute(k, protectedNow ? '1' : '0')
      }
      return [info.name]
    }
    case 'unprotect_sheet': {
      const info = wb.requireWorksheet(op.sheet)
      const cur = protectionEl(wb, info.name)
      if (!cur) return []
      if (!passwordMatches(cur, SHEET_ATTRS, op.password ?? ''))
        throw new XlsxError(
          op.password
            ? 'The password is not correct.'
            : `“${info.name}” is protected with a password: give it to unprotect the sheet.`,
        )
      const doc = docOf(info.name)
      const el = kid(doc.documentElement!, 'sheetProtection')
      if (el) el.parentNode!.removeChild(el)
      return [info.name]
    }
    case 'protect_workbook': {
      const cur = kid(wb.pkg.xml(wb.part).documentElement!, 'workbookProtection')
      if (cur && truthy(cur.getAttribute('lockStructure')) && hasPasswordOn(cur, BOOK_ATTRS))
        throw new XlsxError(
          'The workbook is already protected with a password; unprotect it first.',
        )
      const doc = wb.edit(wb.part)
      const root = doc.documentElement!
      let el = kid(root, 'workbookProtection')
      if (!el) {
        el = make(doc, 'workbookProtection')
        insertInOrder(root, el, WORKBOOK_ORDER)
      }
      writePassword(el, BOOK_ATTRS, op.password)
      el.setAttribute('lockStructure', '1')
      return []
    }
    case 'unprotect_workbook': {
      const cur = kid(wb.pkg.xml(wb.part).documentElement!, 'workbookProtection')
      if (!cur) return []
      if (!passwordMatches(cur, BOOK_ATTRS, op.password ?? ''))
        throw new XlsxError(
          op.password
            ? 'The password is not correct.'
            : 'The workbook is protected with a password: give it to unprotect it.',
        )
      const doc = wb.edit(wb.part)
      const el = kid(doc.documentElement!, 'workbookProtection')
      if (el) el.parentNode!.removeChild(el)
      return []
    }
    case 'set_cell_protection':
      return setCellProtection(wb, op)
  }
}

/** The cellXfs index of `xfIndex` with its protection changed (a copy, or an identical record). */
function xfWithProtection(
  doc: XMLDocument,
  xfIndex: number,
  locked: boolean | undefined,
  hidden: boolean | undefined,
): number {
  const xfsEl = ensureCellXfs(doc)
  const xfs = kids(xfsEl, 'xf')
  const base = xfs[xfIndex] ?? xfs[0]!
  const copy = base.cloneNode(true) as Element
  let p = kid(copy, 'protection')
  if (!p) {
    p = make(doc, 'protection')
    copy.appendChild(p)
  }
  if (locked !== undefined) {
    if (locked) p.removeAttribute('locked')
    else p.setAttribute('locked', '0')
  }
  if (hidden !== undefined) {
    if (hidden) p.setAttribute('hidden', '1')
    else p.removeAttribute('hidden')
  }
  if (p.attributes.length === 0) copy.removeChild(p)
  if (kid(copy, 'protection')) copy.setAttribute('applyProtection', '1')
  else copy.removeAttribute('applyProtection')
  const key = deepSignature(copy)
  if (deepSignature(base) === key) return xfs[xfIndex] ? xfIndex : 0
  const same = xfs.findIndex((x) => deepSignature(x) === key)
  if (same >= 0) return same
  xfsEl.appendChild(copy)
  xfsEl.setAttribute('count', String(xfs.length + 1))
  return xfs.length
}

function setCellProtection(
  wb: Workbook,
  op: Extract<ProtectionOp, { op: 'set_cell_protection' }>,
): string[] {
  const info = wb.requireWorksheet(op.sheet)
  const range = requireRange(op.range)
  if (op.locked === undefined && op.hidden === undefined)
    throw new XlsxError('Say whether the cells are locked, hidden, or both.')
  const n = (range.bottom - range.top + 1) * (range.right - range.left + 1)
  if (n > 100_000)
    throw new XlsxError(`${rangeName(range)} is ${n} cells; change at most 100000 at a time.`)
  return restyleRange(wb, info.name, range, (sdoc, cur) =>
    xfWithProtection(sdoc, cur, op.locked, op.hidden),
  )
}

/** Gives every cell of `range` the format `next(stylesDoc, cur)` (also the hyperlink look, ./hyperlinks.ts). */
export function restyleRange(
  wb: Workbook,
  sheet: string,
  range: Range,
  next: (stylesDoc: XMLDocument, cur: number) => number,
): string[] {
  const info = wb.requireWorksheet(sheet)
  const data = wb.sheet(info.name)
  const doc = sheetDoc(wb, info)
  const sdoc = stylesDoc(wb)
  const memo = new Map<number, number>()
  for (let r = range.top; r <= range.bottom; r++)
    for (let c = range.left; c <= range.right; c++) {
      const cur = data.cells.get(cellKey(r, c))?.style ?? 0
      let to = memo.get(cur)
      if (to === undefined) {
        to = next(sdoc, cur)
        memo.set(cur, to)
      }
      if (to !== cur) restyle(wb, doc, r, c, to)
    }
  finishSheet(wb, info, doc)
  return [info.name]
}
