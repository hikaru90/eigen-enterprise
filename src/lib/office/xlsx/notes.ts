import type { RefEdit } from './shift'
import { strToU8 } from 'fflate'
import { relsPartOf } from '../ooxml/package'
import { setRelElement } from './drawing'
import { cellName, parseCell, type CellAddr } from './ref'
import { editRange } from './shift'
import { relativeTarget, XlsxError, type SheetInfo, type Workbook } from './workbook'
import { all, kid, kids, NS_MAIN, NS_R, REL, setText, textOf } from './xml'

/**
 * Cell notes — Excel's "legacy comments" (ECMA-376 Part 1 §18.7): the text
 * and author in the sheet's comments part, the yellow box in its VML drawing
 * (`legacyDrawing`, a `v:shape` with `x:ClientData ObjectType="Note"` naming
 * the cell and where the box sits). Both parts are written so Excel shows
 * the note: a new note gets its comment, its VML shape and, when the sheet
 * has none yet, the parts, relationships and the `<legacyDrawing>` element.
 *
 * Threaded comments (./threads.ts) keep a legacy comment on their cell too,
 * for older Excel; those are theirs, and the note functions here skip them.
 */

export const REL_COMMENTS = `${REL}comments`
export const REL_VML = `${REL}vmlDrawing`
export const REL_THREADED = 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment'
export const NS_THREADED = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments'
const CT_COMMENTS = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml'
const CT_VML = 'application/vnd.openxmlformats-officedocument.vmlDrawing'
export const NS_V = 'urn:schemas-microsoft-com:vml'
export const NS_O = 'urn:schemas-microsoft-com:office:office'
export const NS_X = 'urn:schemas-microsoft-com:office:excel'

export type Note = {
  ref: string
  row: number
  col: number
  author: string
  text: string
  /** Shown all the time (Show Note), rather than on hover. */
  visible: boolean
}

export type NoteOp =
  | {
      op: 'set_note'
      sheet: string
      ref: string
      /** The note's text (required for a new note). */
      text?: string
      /** Who writes it (a new note, or the author of an edited one). */
      author?: string
      visible?: boolean
    }
  | { op: 'delete_note'; sheet: string; ref: string }

// ---------------------------------------------------------------------------
// Parts

const relOf = (wb: Workbook, info: SheetInfo, type: string) =>
  wb.pkg.relationships(info.part).find((r) => r.type === type && r.part && wb.pkg.has(r.part)) ?? null

export function commentsPartOf(wb: Workbook, info: SheetInfo): string | null {
  return relOf(wb, info, REL_COMMENTS)?.part ?? null
}

export function threadedPartOf(wb: Workbook, info: SheetInfo): string | null {
  return relOf(wb, info, REL_THREADED)?.part ?? null
}

/** The sheet's VML drawing (`<legacyDrawing r:id>`), or null. */
export function vmlPartOf(wb: Workbook, info: SheetInfo): string | null {
  const el = kid(wb.pkg.xml(info.part).documentElement!, 'legacyDrawing')
  const id = el?.getAttributeNS(NS_R, 'id')
  if (!id) return null
  const rel = wb.pkg.relationships(info.part).find((r) => r.id === id)
  return rel?.part && wb.pkg.has(rel.part) ? rel.part : null
}

/** Cells that carry a threaded comment (their legacy comment is the thread's stand-in). */
export function threadedRefs(wb: Workbook, info: SheetInfo): Set<string> {
  const part = threadedPartOf(wb, info)
  const out = new Set<string>()
  if (!part) return out
  for (const c of all(wb.pkg.xml(part), 'threadedComment', NS_THREADED)) {
    const a = parseCell(c.getAttribute('ref') ?? '')
    if (a) out.add(cellName(a))
  }
  return out
}

/** A comment's text: its `<t>` or its runs' text (phonetic runs left out). */
function commentText(c: Element): string {
  const text = kid(c, 'text')
  if (!text) return ''
  const runs = kids(text, 'r')
  return runs.length === 0 ? textOf(kid(text, 't')) : runs.map((r) => textOf(kid(r, 't'))).join('')
}

/** The VML note shapes of a sheet, by cell. */
function vmlShapes(wb: Workbook, info: SheetInfo, doc?: XMLDocument): Map<string, Element> {
  const out = new Map<string, Element>()
  const part = vmlPartOf(wb, info)
  if (!part) return out
  for (const shape of all(doc ?? wb.pkg.xml(part), 'shape', NS_V)) {
    const cd = kid(shape, 'ClientData', NS_X)
    if (!cd || cd.getAttribute('ObjectType') !== 'Note') continue
    const row = Number(textOf(kid(cd, 'Row', NS_X)))
    const col = Number(textOf(kid(cd, 'Column', NS_X)))
    if (Number.isInteger(row) && Number.isInteger(col)) out.set(cellName({ row, col }), shape)
  }
  return out
}

/** The sheet's notes (threaded comments' stand-ins left out), in file order. */
export function readNotes(wb: Workbook, info: SheetInfo): Note[] {
  const part = commentsPartOf(wb, info)
  if (!part) return []
  const root = wb.pkg.xml(part).documentElement!
  const authors = kids(kid(root, 'authors') ?? root, 'author').map(textOf)
  const threaded = threadedRefs(wb, info)
  const shapes = vmlShapes(wb, info)
  const out: Note[] = []
  for (const c of kids(kid(root, 'commentList') ?? root, 'comment')) {
    const ref = c.getAttribute('ref') ?? ''
    const a = parseCell(ref)
    if (!a || threaded.has(cellName(a))) continue
    const shape = shapes.get(cellName(a))
    out.push({
      ref: cellName(a),
      row: a.row,
      col: a.col,
      author: authors[Number(c.getAttribute('authorId') ?? 0)] ?? '',
      text: commentText(c),
      visible: !!shape && !!kid(kid(shape, 'ClientData', NS_X)!, 'Visible', NS_X),
    })
  }
  return out
}

function ensureCommentsPart(wb: Workbook, info: SheetInfo): string {
  const have = commentsPartOf(wb, info)
  if (have) return have
  let n = 1
  while (wb.pkg.has(`/xl/comments${n}.xml`)) n++
  const part = `/xl/comments${n}.xml`
  wb.write(
    part,
    strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="${NS_MAIN}"><authors/><commentList/></comments>`,
    ),
    CT_COMMENTS,
  )
  wb.touch(relsPartOf(info.part))
  wb.pkg.addRelationship(info.part, REL_COMMENTS, relativeTarget(info.part, part))
  return part
}

/** Whether `p` is a VML drawing (a part without a content type is none). */
function isVml(wb: Workbook, p: string): boolean {
  try {
    return wb.pkg.contentType(p) === CT_VML
  } catch {
    return false
  }
}

/** The VML drawing blocks (`o:idmap data`) every sheet's VML uses: a new one takes the next. */
function usedIdBlocks(wb: Workbook): number[] {
  const out: number[] = []
  for (const p of wb.pkg.partNames()) {
    if (!isVml(wb, p)) continue
    for (const m of all(wb.pkg.xml(p), 'idmap', NS_O))
      for (const d of (m.getAttribute('data') ?? '').split(',')) if (d.trim()) out.push(Number(d))
  }
  return out
}

export type SheetDocSource = XMLDocument | (() => XMLDocument)
const resolveSheetDoc = (s: SheetDocSource): XMLDocument => (typeof s === 'function' ? s() : s)

export function ensureVmlPart(wb: Workbook, info: SheetInfo, sheetDoc: SheetDocSource): string {
  const have = vmlPartOf(wb, info)
  if (have) return have
  let n = 1
  while (wb.pkg.has(`/xl/drawings/vmlDrawing${n}.vml`)) n++
  const part = `/xl/drawings/vmlDrawing${n}.vml`
  const block = Math.max(0, ...usedIdBlocks(wb)) + 1
  wb.write(
    part,
    strToU8(
      `<xml xmlns:v="${NS_V}" xmlns:o="${NS_O}" xmlns:x="${NS_X}"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${block}"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></xml>`,
    ),
    CT_VML,
  )
  wb.touch(relsPartOf(info.part))
  const id = wb.pkg.addRelationship(info.part, REL_VML, relativeTarget(info.part, part))
  setRelElement(resolveSheetDoc(sheetDoc), 'legacyDrawing', id)
  return part
}

const ns = (doc: XMLDocument, uri: string, local: string, prefix: string) =>
  doc.createElementNS(uri, `${doc.documentElement!.lookupPrefix(uri) ?? prefix}:${local}`)

/** A note's yellow box in the VML drawing, placed right of the cell as Excel puts a new note. */
function addVmlShape(doc: XMLDocument, at: CellAddr, visible: boolean) {
  const root = doc.documentElement!
  let max = 0
  for (const s of all(doc, 'shape', NS_V)) {
    const m = /_x0000_s(\d+)$/.exec(s.getAttribute('id') ?? '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  if (max === 0) {
    const block = Number((all(doc, 'idmap', NS_O)[0]?.getAttribute('data') ?? '1').split(',')[0])
    max = block * 1024
  }
  if (!all(doc, 'shapetype', NS_V).some((t) => t.getAttribute('id') === '_x0000_t202')) {
    const t = ns(doc, NS_V, 'shapetype', 'v')
    t.setAttribute('id', '_x0000_t202')
    t.setAttribute('coordsize', '21600,21600')
    t.setAttributeNS(NS_O, `${root.lookupPrefix(NS_O) ?? 'o'}:spt`, '202')
    t.setAttribute('path', 'm,l,21600r21600,l21600,xe')
    root.appendChild(t)
  }
  const shape = ns(doc, NS_V, 'shape', 'v')
  shape.setAttribute('id', `_x0000_s${max + 1}`)
  shape.setAttribute('type', '#_x0000_t202')
  shape.setAttribute(
    'style',
    `position:absolute;margin-left:${(at.col + 1) * 48 + 11}pt;margin-top:${Math.max(0, at.row - 1) * 15 + 7.5}pt;width:108pt;height:59.25pt;z-index:${max + 1};visibility:${visible ? 'visible' : 'hidden'}`,
  )
  shape.setAttribute('fillcolor', '#ffffe1')
  shape.setAttributeNS(NS_O, `${root.lookupPrefix(NS_O) ?? 'o'}:insetmode`, 'auto')
  const fill = ns(doc, NS_V, 'fill', 'v')
  fill.setAttribute('color2', '#ffffe1')
  const shadow = ns(doc, NS_V, 'shadow', 'v')
  shadow.setAttribute('on', 't')
  shadow.setAttribute('color', 'black')
  shadow.setAttribute('obscured', 't')
  const path = ns(doc, NS_V, 'path', 'v')
  path.setAttributeNS(NS_O, `${root.lookupPrefix(NS_O) ?? 'o'}:connecttype`, 'none')
  const box = ns(doc, NS_V, 'textbox', 'v')
  box.setAttribute('style', 'mso-direction-alt:auto')
  const cd = ns(doc, NS_X, 'ClientData', 'x')
  cd.setAttribute('ObjectType', 'Note')
  const x = (local: string, text?: string) => {
    const e = ns(doc, NS_X, local, 'x')
    if (text !== undefined) e.appendChild(doc.createTextNode(text))
    cd.appendChild(e)
  }
  x('MoveWithCells')
  x('SizeWithCells')
  const top = Math.max(0, at.row - 1)
  x('Anchor', `${at.col + 1}, 15, ${top}, 10, ${at.col + 3}, 15, ${top + 4}, 4`)
  x('AutoFill', 'False')
  x('Row', String(at.row))
  x('Column', String(at.col))
  if (visible) x('Visible')
  for (const k of [fill, shadow, path, box, cd]) shape.appendChild(k)
  root.appendChild(shape)
}

function setVisible(shape: Element, visible: boolean) {
  const doc = shape.ownerDocument!
  const cd = kid(shape, 'ClientData', NS_X)!
  const v = kid(cd, 'Visible', NS_X)
  if (visible && !v) cd.appendChild(ns(doc, NS_X, 'Visible', 'x'))
  if (!visible && v) cd.removeChild(v)
  const style = shape.getAttribute('style') ?? ''
  const next = /visibility:\s*\w+/.test(style)
    ? style.replace(/visibility:\s*\w+/, `visibility:${visible ? 'visible' : 'hidden'}`)
    : `${style}${style ? ';' : ''}visibility:${visible ? 'visible' : 'hidden'}`
  shape.setAttribute('style', next)
}

function authorIndex(doc: XMLDocument, name: string): number {
  const root = doc.documentElement!
  let authors = kid(root, 'authors')
  if (!authors) {
    authors = doc.createElementNS(NS_MAIN, root.prefix ? `${root.prefix}:authors` : 'authors')
    root.insertBefore(authors, root.firstChild)
  }
  const list = kids(authors, 'author')
  const i = list.findIndex((a) => textOf(a) === name)
  if (i >= 0) return i
  const a = doc.createElementNS(NS_MAIN, root.prefix ? `${root.prefix}:author` : 'author')
  a.appendChild(doc.createTextNode(name))
  authors.appendChild(a)
  return list.length
}

/** Writes (adds or replaces) the legacy comment on `ref`, with its VML shape. Returns the comment element. */
export function writeLegacyComment(
  wb: Workbook,
  info: SheetInfo,
  sheetDoc: SheetDocSource,
  ref: string,
  text: string,
  author: string,
  visible?: boolean,
) {
  const at = parseCell(ref)!
  const part = ensureCommentsPart(wb, info)
  const doc = wb.edit(part)
  const root = doc.documentElement!
  let list = kid(root, 'commentList')
  if (!list) {
    list = doc.createElementNS(NS_MAIN, root.prefix ? `${root.prefix}:commentList` : 'commentList')
    root.appendChild(list)
  }
  let c = kids(list, 'comment').find((x) => {
    const ca = parseCell(x.getAttribute('ref') ?? '')
    return ca ? cellName(ca) === ref : x.getAttribute('ref') === ref
  }) ?? null
  if (!c) {
    c = doc.createElementNS(NS_MAIN, root.prefix ? `${root.prefix}:comment` : 'comment')
    c.setAttribute('ref', ref)
    // CT_CommentList keeps comments in cell order (row, then column), as Excel writes them.
    const next = kids(list, 'comment').find((x) => {
      const b = parseCell(x.getAttribute('ref') ?? '')
      return b && (b.row > at.row || (b.row === at.row && b.col > at.col))
    })
    list.insertBefore(c, next ?? null)
  }
  c.setAttribute('authorId', String(authorIndex(doc, author)))
  let t = kid(c, 'text')
  if (t) c.removeChild(t)
  t = doc.createElementNS(NS_MAIN, root.prefix ? `${root.prefix}:text` : 'text')
  const tt = doc.createElementNS(NS_MAIN, root.prefix ? `${root.prefix}:t` : 't')
  setText(doc, tt, text)
  t.appendChild(tt)
  c.insertBefore(t, c.firstChild)
  const vml = ensureVmlPart(wb, info, sheetDoc)
  const vdoc = wb.edit(vml)
  const shape = vmlShapes(wb, info, vdoc).get(ref)
  if (!shape) addVmlShape(vdoc, at, visible ?? false)
  else if (visible !== undefined) setVisible(shape, visible)
}

/** Removes the legacy comment on `ref` and its VML shape; empty parts go with their relationships. */
export function removeLegacyComment(wb: Workbook, info: SheetInfo, sheetDoc: SheetDocSource, ref: string) {
  const part = commentsPartOf(wb, info)
  if (part) {
    const doc = wb.edit(part)
    const list = kid(doc.documentElement!, 'commentList')
    for (const c of list ? kids(list, 'comment') : []) {
      const ca = parseCell(c.getAttribute('ref') ?? '')
      if ((ca ? cellName(ca) : c.getAttribute('ref')) === ref) list!.removeChild(c)
    }
  }
  const vml = vmlPartOf(wb, info)
  if (vml) {
    const vdoc = wb.edit(vml)
    const shape = vmlShapes(wb, info, vdoc).get(ref)
    shape?.parentNode?.removeChild(shape)
  }
  dropEmptyParts(wb, info, sheetDoc)
}

/** A comments part without comments, a VML drawing without shapes: removed, with their relationship (and `<legacyDrawing>`). */
export function dropEmptyParts(wb: Workbook, info: SheetInfo, sheetDoc: SheetDocSource) {
  const dropRel = (part: string) => {
    const rel = wb.pkg.relationships(info.part).find((r) => r.part === part)
    if (!rel) return
    const rels = wb.edit(relsPartOf(info.part))
    for (const el of kids(rels.documentElement!, 'Relationship', 'http://schemas.openxmlformats.org/package/2006/relationships'))
      if (el.getAttribute('Id') === rel.id) rels.documentElement!.removeChild(el)
    return rel.id
  }
  const part = commentsPartOf(wb, info)
  if (part && kids(kid(wb.pkg.xml(part).documentElement!, 'commentList') ?? wb.pkg.xml(part).documentElement!, 'comment').length === 0) {
    dropRel(part)
    wb.remove(part)
  }
  const vml = vmlPartOf(wb, info)
  if (vml && all(wb.pkg.xml(vml), 'shape', NS_V).length === 0) {
    const id = dropRel(vml)
    wb.remove(vml)
    const sdoc = resolveSheetDoc(sheetDoc)
    const el = kid(sdoc.documentElement!, 'legacyDrawing')
    if (el && el.getAttributeNS(NS_R, 'id') === id) sdoc.documentElement!.removeChild(el)
  }
}

// ---------------------------------------------------------------------------
// Operations

export function runNoteOp(wb: Workbook, op: NoteOp, sheetDoc: SheetDocSource) {
  const info = wb.requireWorksheet(op.sheet)
  const at = parseCell(op.ref)
  if (!at) throw new XlsxError(`“${op.ref}” is not a cell address (like A1).`)
  const ref = cellName(at)
  if (threadedRefs(wb, info).has(ref))
    throw new XlsxError(`${info.name}!${ref} has a comment thread; a cell holds a note or a comment, not both.`)
  const have = readNotes(wb, info).find((n) => n.ref === ref)
  if (op.op === 'delete_note') {
    if (!have) throw new XlsxError(`${info.name}!${ref} has no note.`)
    removeLegacyComment(wb, info, sheetDoc, ref)
    return
  }
  const text = op.text ?? have?.text
  if (text === undefined) throw new XlsxError(`${info.name}!${ref} has no note yet: give its text.`)
  if (text.trim() === '') throw new XlsxError('A note needs text (delete the note to remove it).')
  if (text.length > 32_767) throw new XlsxError('A note can hold at most 32767 characters.')
  const author = op.author ?? have?.author ?? ''
  writeLegacyComment(wb, info, sheetDoc, ref, text, author, op.visible ?? (have ? undefined : false))
}

// ---------------------------------------------------------------------------
// Moving with the cells

/**
 * Changes a part's cached XML through `mutate` and records it in the open
 * transaction only when something changed, so a part nothing moved in keeps
 * its exact bytes.
 */
export function editIfChanged(wb: Workbook, part: string, mutate: (doc: XMLDocument) => boolean) {
  if (mutate(wb.pkg.xml(part))) wb.edit(part)
}

const cellRange = (a: CellAddr) => ({ top: a.row, bottom: a.row, left: a.col, right: a.col })

/** Notes (and threads' stand-ins) follow inserted/deleted rows or columns; a note on a deleted cell goes. */
export function shiftLegacyComments(wb: Workbook, info: SheetInfo, sheetDoc: XMLDocument, edit: RefEdit) {
  const part = commentsPartOf(wb, info)
  if (part)
    editIfChanged(wb, part, (doc) => {
      let changed = false
      const list = kid(doc.documentElement!, 'commentList')
      for (const c of list ? kids(list, 'comment') : []) {
        const a = parseCell(c.getAttribute('ref') ?? '')
        if (!a) continue
        const moved = editRange(cellRange(a), info.name, edit)
        if (!moved) list!.removeChild(c)
        else if (moved.top !== a.row || moved.left !== a.col)
          c.setAttribute('ref', cellName({ row: moved.top, col: moved.left }))
        else continue
        changed = true
      }
      return changed
    })
  const vml = vmlPartOf(wb, info)
  if (vml)
    editIfChanged(wb, vml, (vdoc) => {
      let changed = false
      for (const shape of all(vdoc, 'shape', NS_V)) {
        const cd = kid(shape, 'ClientData', NS_X)
        const rowEl = cd ? kid(cd, 'Row', NS_X) : null
        const colEl = cd ? kid(cd, 'Column', NS_X) : null
        if (!rowEl || !colEl) continue
        const a = { row: Number(textOf(rowEl)), col: Number(textOf(colEl)) }
        const moved = editRange(cellRange(a), info.name, edit)
        if (!moved) {
          if (cd!.getAttribute('ObjectType') === 'Note') {
            shape.parentNode!.removeChild(shape)
            changed = true
          }
          continue
        }
        if (moved.top === a.row && moved.left === a.col) continue
        rowEl.textContent = String(moved.top)
        colEl.textContent = String(moved.left)
        moveVmlAnchor(cd!, moved.top - a.row, moved.left - a.col)
        changed = true
      }
      return changed
    })
  dropEmptyParts(wb, info, sheetDoc)
}

/** `x:Anchor` (left col, offset, top row, offset, right col, offset, bottom row, offset) moved by rows/columns. */
function moveVmlAnchor(cd: Element, dr: number, dc: number) {
  const anchorEl = kid(cd, 'Anchor', NS_X)
  if (!anchorEl) return
  const n = textOf(anchorEl)
    .split(',')
    .map((s) => Number(s.trim()))
  if (n.length !== 8 || !n.every(Number.isFinite)) return
  n[0] = Math.max(0, n[0]! + dc)
  n[4] = Math.max(0, n[4]! + dc)
  n[2] = Math.max(0, n[2]! + dr)
  n[6] = Math.max(0, n[6]! + dr)
  anchorEl.textContent = n.join(', ')
}

/** Sorted rows: notes on the sorted cells move with their rows (`dest`: old row → new row, columns left…right). */
export function sortLegacyComments(
  wb: Workbook,
  info: SheetInfo,
  dest: Map<number, number>,
  left: number,
  right: number,
) {
  const inCols = (c: number) => c >= left && c <= right
  const part = commentsPartOf(wb, info)
  if (part)
    editIfChanged(wb, part, (doc) => {
      let changed = false
      const list = kid(doc.documentElement!, 'commentList')
      for (const c of list ? kids(list, 'comment') : []) {
        const a = parseCell(c.getAttribute('ref') ?? '')
        const to = a && inCols(a.col) ? dest.get(a.row) : undefined
        if (!a || to === undefined) continue
        c.setAttribute('ref', cellName({ row: to, col: a.col }))
        changed = true
      }
      return changed
    })
  const vml = vmlPartOf(wb, info)
  if (vml)
    editIfChanged(wb, vml, (vdoc) => {
      let changed = false
      for (const shape of all(vdoc, 'shape', NS_V)) {
        const cd = kid(shape, 'ClientData', NS_X)
        const rowEl = cd ? kid(cd, 'Row', NS_X) : null
        const colEl = cd ? kid(cd, 'Column', NS_X) : null
        if (!rowEl || !colEl || !inCols(Number(textOf(colEl)))) continue
        const from = Number(textOf(rowEl))
        const to = dest.get(from)
        if (to === undefined) continue
        rowEl.textContent = String(to)
        moveVmlAnchor(cd!, to - from, 0)
        changed = true
      }
      return changed
    })
}
