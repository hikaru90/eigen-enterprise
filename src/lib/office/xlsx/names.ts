import { parseA1Ref, stringifyA1Ref, tokenize } from '@borgar/fx/xlsx'
import { rewriteAllFormulas, toFileFormula, toShownFormula } from './ops'
import { colIndex } from './ref'
import { XlsxError, type Workbook } from './workbook'
import { insertInOrder, kid, kids, make, setText, textOf, WORKBOOK_ORDER } from './xml'

/**
 * Excel's Name Manager (ECMA-376 Part 1 §18.2.5 definedName): list, add,
 * edit and delete defined names, workbook-wide or for one sheet. A name is
 * checked with Excel's rules (letter, underscore or backslash first; then
 * letters, digits, `_ . \`; not a cell reference; at most 255 characters;
 * unique in its scope, ignoring case). Renaming a name renames it in every
 * formula that uses it (a sheet-scoped name only on its sheet, or where a
 * formula names that sheet); deleting one leaves formulas that used it
 * showing #NAME?, as in Excel. Excel's own names (`_xlnm.Print_Area`,
 * `_xlnm._FilterDatabase` …) are listed but changed only by their features.
 */

export type NameView = {
  name: string
  /** The sheet a sheet-scoped name belongs to; null: the whole workbook. */
  scope: string | null
  /** What the name refers to, as typed (with "="). */
  refersTo: string
  comment: string | null
  hidden: boolean
  /** Excel's own name (print area, filter range …): not edited here. */
  builtIn: boolean
}

export type NameOp =
  | {
      op: 'name_add'
      name: string
      refersTo: string
      /** A sheet name for a sheet-scoped name; null/omitted: the workbook. */
      scope?: string | null
      comment?: string | null
    }
  | {
      op: 'name_update'
      name: string
      scope?: string | null
      newName?: string
      refersTo?: string
      comment?: string | null
    }
  | { op: 'name_delete'; name: string; scope?: string | null }

const BUILT_IN = /^_xlnm\./i

function namesEl(wb: Workbook): Element | null {
  return kid(wb.pkg.xml(wb.part).documentElement!, 'definedNames')
}

export function listNames(wb: Workbook): NameView[] {
  const sheets = wb.sheets()
  const el = namesEl(wb)
  return (el ? kids(el, 'definedName') : []).map((d) => {
    const local = d.getAttribute('localSheetId')
    const name = d.getAttribute('name') ?? ''
    return {
      name,
      scope: local === null ? null : (sheets[Number(local)]?.name ?? null),
      refersTo: `=${toShownFormula(textOf(d))}`,
      comment: d.getAttribute('comment'),
      hidden: d.getAttribute('hidden') === '1' || d.getAttribute('hidden') === 'true',
      builtIn: BUILT_IN.test(name),
    }
  })
}

/** Excel's name rules; returns the name as typed (trimmed). */
export function checkName(text: string): string {
  const n = text.trim()
  if (n === '') throw new XlsxError('A name can’t be empty.')
  if (n.length > 255) throw new XlsxError(`“${n.slice(0, 20)}…” is longer than 255 characters.`)
  if (!/^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u.test(n))
    throw new XlsxError(
      `“${n}” is not a valid name: start with a letter, _ or \\, then letters, digits, _ . or \\ (no spaces).`,
    )
  // Cell references (A1, XFD1048576, R1C1, R, C) can't be names.
  const a1 = /^([A-Za-z]{1,3})(\d+)$/.exec(n)
  if (
    (a1 && colIndex(a1[1]!) !== null && Number(a1[2]) >= 1 && Number(a1[2]) <= 1_048_576) ||
    /^[RrCc]$/.test(n) ||
    /^[Rr]\d*[Cc]\d*$/.test(n)
  )
    throw new XlsxError(`“${n}” looks like a cell reference, which can’t be a name.`)
  if (BUILT_IN.test(n)) throw new XlsxError(`“${n}” is a name Excel keeps for itself.`)
  return n
}

function scopeIndex(wb: Workbook, scope: string | null | undefined): number | null {
  if (scope === null || scope === undefined || scope === '') return null
  return wb.requireSheet(scope).index
}

function findEl(
  wb: Workbook,
  doc: XMLDocument,
  name: string,
  local: number | null,
): Element | null {
  const el = kid(doc.documentElement!, 'definedNames')
  const key = name.toLowerCase()
  return (
    (el ? kids(el, 'definedName') : []).find(
      (d) =>
        (d.getAttribute('name') ?? '').toLowerCase() === key &&
        (d.getAttribute('localSheetId') === null
          ? null
          : Number(d.getAttribute('localSheetId'))) === local,
    ) ?? null
  )
}

const where = (wb: Workbook, local: number | null) =>
  local === null ? 'in the workbook' : `on the sheet “${wb.sheets()[local]?.name}”`

function refersToText(text: string, label: string): string {
  const t = text.trim()
  if (t === '' || t === '=')
    throw new XlsxError(`${label}: say what the name refers to (like =Sheet1!$A$1:$A$10).`)
  return toFileFormula(t, label)
}

export function runNameOp(wb: Workbook, op: NameOp): void {
  const doc = wb.edit(wb.part)
  const root = doc.documentElement!
  switch (op.op) {
    case 'name_add': {
      const name = checkName(op.name)
      const local = scopeIndex(wb, op.scope)
      if (findEl(wb, doc, name, local))
        throw new XlsxError(`There is already a name “${name}” ${where(wb, local)}.`)
      const formula = refersToText(op.refersTo, name)
      let list = kid(root, 'definedNames')
      if (!list) {
        list = make(doc, 'definedNames')
        insertInOrder(root, list, WORKBOOK_ORDER)
      }
      const el = make(doc, 'definedName')
      el.setAttribute('name', name)
      if (op.comment) el.setAttribute('comment', op.comment)
      if (local !== null) el.setAttribute('localSheetId', String(local))
      setText(doc, el, formula)
      // Excel keeps the list sorted by name (then scope); new names land in that order.
      const after = kids(list, 'definedName').find(
        (d) => (d.getAttribute('name') ?? '').toLowerCase() > name.toLowerCase(),
      )
      list.insertBefore(el, after ?? null)
      return
    }
    case 'name_update': {
      const local = scopeIndex(wb, op.scope)
      const el = findEl(wb, doc, op.name, local)
      if (!el) throw new XlsxError(`There is no name “${op.name}” ${where(wb, local)}.`)
      if (BUILT_IN.test(el.getAttribute('name') ?? ''))
        throw new XlsxError(`“${op.name}” is Excel’s own name; change it through its feature.`)
      const old = el.getAttribute('name') ?? ''
      if (op.refersTo !== undefined) setText(doc, el, refersToText(op.refersTo, old))
      if (op.comment !== undefined) {
        if (op.comment) el.setAttribute('comment', op.comment)
        else el.removeAttribute('comment')
      }
      if (op.newName !== undefined && op.newName.trim() !== old) {
        const next = checkName(op.newName)
        const clash = findEl(wb, doc, next, local)
        if (clash && clash !== el)
          throw new XlsxError(`There is already a name “${next}” ${where(wb, local)}.`)
        el.setAttribute('name', next)
        renameInFormulas(wb, old, next, local === null ? null : (wb.sheets()[local]?.name ?? null))
      }
      return
    }
    case 'name_delete': {
      const local = scopeIndex(wb, op.scope)
      const el = findEl(wb, doc, op.name, local)
      if (!el) throw new XlsxError(`There is no name “${op.name}” ${where(wb, local)}.`)
      if (BUILT_IN.test(el.getAttribute('name') ?? ''))
        throw new XlsxError(`“${op.name}” is Excel’s own name; remove it through its feature.`)
      const list = el.parentNode as Element
      list.removeChild(el)
      if (kids(list, 'definedName').length === 0) root.removeChild(list)
      return
    }
  }
}

type FxToken = { type: string; value: string }
type NamedRef = { workbookName?: string; sheetName?: string; name?: string }

/**
 * Renames a defined name in every formula (cells, conditional formats,
 * validations, other names). A sheet-scoped name (`scope` its sheet) is
 * renamed in formulas on that sheet and where a formula names that sheet;
 * a workbook name everywhere a sheet-scoped name of the same name doesn't
 * shadow it.
 */
function renameInFormulas(wb: Workbook, from: string, to: string, scope: string | null) {
  const key = from.toLowerCase()
  const shadowed = new Set(
    wb
      .definedNames()
      .filter((n) => n.localSheet !== null && n.name.toLowerCase() === key)
      .map((n) => wb.sheets()[n.localSheet!]?.name.toLowerCase()),
  )
  rewriteAllFormulas(wb, (formula, home) => {
    if (!formula.toLowerCase().includes(key)) return formula
    let changed = false
    const out = (tokenize(formula, { mergeRefs: true }) as FxToken[]).map((t) => {
      if (t.type !== 'range_named') return t.value
      const ref = parseA1Ref(t.value) as NamedRef | undefined
      if (!ref?.name || ref.workbookName || ref.name.toLowerCase() !== key) return t.value
      const sheet = (ref.sheetName || home).toLowerCase()
      const hit =
        scope === null ? !ref.sheetName && !shadowed.has(sheet) : sheet === scope.toLowerCase()
      if (!hit) return t.value
      changed = true
      return stringifyA1Ref({ ...ref, name: to } as never)
    })
    return changed ? out.join('') : formula
  })
}
