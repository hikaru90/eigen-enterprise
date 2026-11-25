import { strToU8 } from 'fflate'
import { relsPartOf } from '../ooxml/package'
import { checkSheetName, type Loss, type OpResult } from './ops'
import { WORKSHEET_ORDER } from './sheet-order'
import { renameSheetRefs } from './shift'
import { argb } from './style-records'
import { relativeTarget, XlsxError, type SheetState, type Workbook } from './workbook'
import {
  all,
  CT_WORKSHEET,
  insertInOrder,
  kid,
  kids,
  make,
  NS_R,
  REL_WORKSHEET,
  setText,
  textOf,
} from './xml'

/**
 * Sheet tab operations (ECMA-376 Part 1 §18.2.19 sheet, §18.3.1.85 tabColor):
 * reorder (`move_sheet`), tab colour (`set_sheet_color`), visibility
 * (`set_sheet_visibility`: visible / hidden / veryHidden), and duplicate
 * (`duplicate_sheet`, optionally placed at `to` with a new name).
 */

export type SheetTabOp =
  | { op: 'move_sheet'; sheet: string; to: number }
  | { op: 'set_sheet_color'; sheet: string; color: string | null }
  | { op: 'set_sheet_visibility'; sheet: string; state: SheetState }
  | { op: 'duplicate_sheet'; sheet: string; name?: string; to?: number }

const SHEET_PR_ORDER = ['tabColor', 'outlinePr', 'pageSetUpPr'] as const

const NON_COPIED_REL_SUFFIXES = [
  '/drawing',
  '/table',
  '/pivotTable',
  '/comments',
  '/threadedComment',
  '/vmlDrawing',
  '/control',
]

const NON_COPIED_ELEMENTS = [
  'drawing',
  'legacyDrawing',
  'legacyDrawingHF',
  'drawingHF',
  'tableParts',
  'oleObjects',
  'controls',
]

/** Reads `<sheetPr><tabColor .../></sheetPr>` as "#RRGGBB" or null. */
export function sheetTabColor(wb: Workbook, sheet: string): string | null {
  const info = wb.requireSheet(sheet)
  const root = wb.pkg.xml(info.part).documentElement!
  const pr = kid(root, 'sheetPr')
  const tc = pr ? kid(pr, 'tabColor') : null
  if (!tc) return null
  const rgb = tc.getAttribute('rgb')
  if (rgb && /^[0-9A-Fa-f]{6,8}$/.test(rgb)) return `#${rgb.slice(-6).toUpperCase()}`
  return null
}

/** Suggests a unique sheet name like "Budget (2)" within Excel's 31-char limit. */
export function nextCopyName(wb: Workbook, sourceName: string): string {
  const taken = new Set(wb.sheets().map((s) => s.name.toLowerCase()))
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`
    const stem = sourceName.slice(0, Math.max(1, 31 - suffix.length)).replace(/'+$/, '') || 'Sheet'
    const candidate = `${stem}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export function sheetTabLosses(wb: Workbook, op: SheetTabOp): Loss[] {
  if (op.op !== 'duplicate_sheet') return []
  const info = wb.requireWorksheet(op.sheet)
  const rels = wb.pkg
    .relationships(info.part)
    .filter((r) => !r.external && NON_COPIED_REL_SUFFIXES.some((s) => r.type.endsWith(s)))
  const root = wb.pkg.xml(info.part).documentElement!
  const ctrl = (kid(root, 'controls') ? 1 : 0) + (kid(root, 'oleObjects') ? 1 : 0)
  const total = rels.length + ctrl
  return total > 0 ? [{ feature: 'not_copied', count: total }] : []
}

function remapWorkbookSheetIndexes(doc: XMLDocument, oldToNew: Map<number, number>) {
  const root = doc.documentElement!
  const namesEl = kid(root, 'definedNames')
  if (namesEl) {
    for (const el of kids(namesEl, 'definedName')) {
      const local = el.getAttribute('localSheetId')
      if (local === null) continue
      const mapped = oldToNew.get(Number(local))
      if (mapped !== undefined) el.setAttribute('localSheetId', String(mapped))
    }
  }
  for (const v of all(doc, 'workbookView')) {
    for (const attr of ['activeTab', 'firstSheet']) {
      const a = v.getAttribute(attr)
      if (a === null) continue
      const mapped = oldToNew.get(Number(a))
      if (mapped !== undefined) v.setAttribute(attr, String(mapped))
    }
  }
}

function moveSheet(wb: Workbook, sheet: string, to: number): OpResult {
  const sheets = wb.sheets()
  const info = wb.requireSheet(sheet)
  if (!Number.isInteger(to) || to < 0 || to >= sheets.length)
    throw new XlsxError(
      `Target position ${to + 1} is outside the workbook’s ${sheets.length} sheets.`,
    )
  if (to === info.index) return { sheets: [] }

  const doc = wb.edit(wb.part)
  const sheetsEl = kid(doc.documentElement!, 'sheets')!
  const nodes = kids(sheetsEl, 'sheet')
  const order = sheets.map((_, i) => i)
  const [movedIdx] = order.splice(info.index, 1)
  order.splice(to, 0, movedIdx!)

  const oldToNew = new Map<number, number>()
  order.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx))

  for (const el of nodes) sheetsEl.removeChild(el)
  for (const oldIdx of order) sheetsEl.appendChild(nodes[oldIdx]!)
  remapWorkbookSheetIndexes(doc, oldToNew)
  wb.invalidate()
  return { sheets: [], focus: info.name }
}

function setSheetColor(wb: Workbook, sheet: string, color: string | null): OpResult {
  const info = wb.requireSheet(sheet)
  if (color !== null) argb(color)
  const doc = wb.edit(info.part)
  const root = doc.documentElement!
  let pr = kid(root, 'sheetPr')
  if (color === null) {
    if (!pr) return { sheets: [] }
    const tc = kid(pr, 'tabColor')
    if (!tc) return { sheets: [] }
    pr.removeChild(tc)
    if (pr.attributes.length === 0 && kids(pr, undefined).length === 0) root.removeChild(pr)
    wb.invalidate()
    return { sheets: [info.name] }
  }
  if (!pr) {
    pr = make(doc, 'sheetPr')
    insertInOrder(root, pr, WORKSHEET_ORDER)
  }
  let tc = kid(pr, 'tabColor')
  if (!tc) {
    tc = make(doc, 'tabColor')
    insertInOrder(pr, tc, SHEET_PR_ORDER)
  }
  for (const attr of ['theme', 'tint', 'indexed', 'auto']) tc.removeAttribute(attr)
  tc.setAttribute('rgb', argb(color))
  wb.invalidate()
  return { sheets: [info.name] }
}

function setSheetVisibility(wb: Workbook, sheet: string, state: SheetState): OpResult {
  if (!['visible', 'hidden', 'veryHidden'].includes(state))
    throw new XlsxError(`“${state}” is not a sheet visibility state.`)
  const info = wb.requireSheet(sheet)
  if (info.state === state) return { sheets: [] }
  const sheets = wb.sheets()
  if (
    info.state === 'visible' &&
    state !== 'visible' &&
    sheets.filter((s) => s.state === 'visible').length <= 1
  ) {
    throw new XlsxError('A workbook needs at least one visible sheet, so this one can’t be hidden.')
  }
  const doc = wb.edit(wb.part)
  const el = kids(kid(doc.documentElement!, 'sheets')!, 'sheet')[info.index]!
  if (state === 'visible') el.removeAttribute('state')
  else el.setAttribute('state', state)
  wb.invalidate()
  const focus =
    state !== 'visible'
      ? wb.sheets().find((s) => s.state === 'visible' && s.part !== info.part)?.name
      : info.name
  return focus ? { sheets: [info.name], focus } : { sheets: [info.name] }
}

function duplicateSheet(wb: Workbook, sheet: string, nameIn?: string, toIn?: number): OpResult {
  const info = wb.requireWorksheet(sheet)
  const sheets = wb.sheets()
  const name = nameIn !== undefined ? checkSheetName(wb, nameIn) : nextCopyName(wb, info.name)
  const insertAt = toIn ?? info.index + 1
  if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > sheets.length)
    throw new XlsxError(`Target position ${insertAt + 1} is outside the workbook’s sheets.`)

  const dir = wb.part.slice(0, wb.part.lastIndexOf('/'))
  let n = sheets.length + 1
  let part = `${dir}/worksheets/sheet${n}.xml`
  while (wb.pkg.has(part)) part = `${dir}/worksheets/sheet${++n}.xml`

  // Clone the worksheet XML cleanly, stripping non-cell part references and clearing tabSelected.
  const srcBytes = wb.pkg.bytes(info.part)
  wb.write(part, new Uint8Array(srcBytes), CT_WORKSHEET)
  const cloneDoc = wb.edit(part)
  const cloneRoot = cloneDoc.documentElement!
  for (const tag of NON_COPIED_ELEMENTS) {
    for (const el of kids(cloneRoot, tag)) cloneRoot.removeChild(el)
  }
  const views = kid(cloneRoot, 'sheetViews')
  if (views) {
    for (const v of kids(views, 'sheetView')) v.removeAttribute('tabSelected')
  }
  // Copy external hyperlink relationships so copied <hyperlink r:id="..."> elements stay valid.
  const extRels = wb.pkg.relationships(info.part).filter((r) => r.external)
  if (extRels.length > 0) {
    const relsPart = relsPartOf(part)
    wb.write(
      relsPart,
      strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${extRels
          .map(
            (r) =>
              `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}" TargetMode="External"/>`,
          )
          .join('')}</Relationships>`,
      ),
    )
  }

  // Register relationship + <sheet> element in workbook.xml at `insertAt`.
  wb.touch(relsPartOf(wb.part))
  const relId = wb.pkg.addRelationship(wb.part, REL_WORKSHEET, relativeTarget(wb.part, part))
  const doc = wb.edit(wb.part)
  const root = doc.documentElement!
  const sheetsEl = kid(root, 'sheets')!
  const existingEls = kids(sheetsEl, 'sheet')
  const el = make(doc, 'sheet')
  el.setAttribute('name', name)
  el.setAttribute('sheetId', String(Math.max(0, ...sheets.map((s) => s.sheetId)) + 1))
  const rPrefix = root.lookupPrefix(NS_R) ?? 'r'
  if (!root.lookupPrefix(NS_R)) root.setAttribute('xmlns:r', NS_R)
  el.setAttributeNS(NS_R, `${rPrefix}:id`, relId)
  if (insertAt < existingEls.length) sheetsEl.insertBefore(el, existingEls[insertAt]!)
  else sheetsEl.appendChild(el)

  // Remap existing localSheetId & workbookViews, then clone sheet-local definedNames for the copy.
  const oldToNew = new Map<number, number>()
  sheets.forEach((_, i) => oldToNew.set(i, i >= insertAt ? i + 1 : i))
  remapWorkbookSheetIndexes(doc, oldToNew)

  const namesEl = kid(root, 'definedNames')
  if (namesEl) {
    const oldSrcMapped = oldToNew.get(info.index)!
    for (const dn of kids(namesEl, 'definedName')) {
      if (dn.getAttribute('localSheetId') !== String(oldSrcMapped)) continue
      const copyDn = dn.cloneNode(true) as Element
      copyDn.setAttribute('localSheetId', String(insertAt))
      setText(doc, copyDn, renameSheetRefs(textOf(dn), info.name, name))
      namesEl.appendChild(copyDn)
    }
  }

  wb.invalidate()
  return { sheets: [name], focus: name }
}

export function runSheetTabOp(wb: Workbook, op: SheetTabOp): OpResult {
  switch (op.op) {
    case 'move_sheet':
      return moveSheet(wb, op.sheet, op.to)
    case 'set_sheet_color':
      return setSheetColor(wb, op.sheet, op.color)
    case 'set_sheet_visibility':
      return setSheetVisibility(wb, op.sheet, op.state)
    case 'duplicate_sheet':
      return duplicateSheet(wb, op.sheet, op.name, op.to)
  }
}
