import type { DocxEditSession, ListKind } from './session'
import type { Mark, MarkType, Node as PMNode } from 'prosemirror-model'
import { chainCommands, splitBlockAs, toggleMark } from 'prosemirror-commands'
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state'
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, goToNextCell, isInTable } from 'prosemirror-tables'
import { wa, wc } from '../xml'
import { effectiveNumbering, FORMAT_MARKS, resolvedParagraph, type IndentTwips, type ParagraphAttrs } from './schema'

/**
 * Editing commands for the toolbar and keyboard (ProseMirror `Command`s:
 * with no `dispatch` they only answer whether they apply). Paragraph
 * commands work on every paragraph the selection touches, table cells
 * included.
 */

export type ParagraphAt = { pos: number; node: PMNode }

/** The paragraphs the selection touches, in document order. */
export function selectedParagraphs(state: EditorState): ParagraphAt[] {
  const { from, to } = state.selection
  const out: ParagraphAt[] = []
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      out.push({ pos, node })
      return false
    }
    return true
  })
  return out
}

function patchParagraphs(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, patch: (p: ParagraphAt, i: number) => Partial<ParagraphAttrs> | null): boolean {
  const paras = selectedParagraphs(state)
  if (paras.length === 0) return false
  if (!dispatch) return true
  const tr = state.tr
  paras.forEach((p, i) => {
    const change = patch(p, i)
    if (change) tr.setNodeMarkup(p.pos, null, { ...p.node.attrs, ...change })
  })
  dispatch(tr.scrollIntoView())
  return true
}

export const toggleFormat = (type: MarkType): Command => toggleMark(type)

/** Sets a valued mark (size, colour, highlight, font, character style) over the selection; null removes it. */
export function setFormat(type: MarkType, attrs: Record<string, unknown> | null): Command {
  return (state, dispatch) => {
    if (!dispatch) return true
    const { from, to, empty } = state.selection
    const tr = state.tr
    if (empty) {
      const marks = type.removeFromSet(state.storedMarks ?? state.selection.$from.marks())
      tr.setStoredMarks(attrs ? type.create(attrs).addToSet(marks) : marks)
    } else {
      tr.removeMark(from, to, type)
      if (attrs) tr.addMark(from, to, type.create(attrs))
    }
    dispatch(tr.scrollIntoView())
    return true
  }
}

/** Superscript/subscript on or off (w:vertAlign). */
export function toggleVertAlign(val: 'superscript' | 'subscript'): Command {
  return (state, dispatch) => {
    const type = state.schema.marks.vertAlign!
    const on = activeMark(state, type)?.attrs.val === val
    return setFormat(type, on ? null : { val })(state, dispatch)
  }
}

/** The mark of `type` at the cursor (stored marks first) or on the start of the selection. */
export function activeMark(state: EditorState, type: MarkType): Mark | null {
  const { empty, $from, from, to } = state.selection
  if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) ?? null
  let found: Mark | null = null
  state.doc.nodesBetween(from, to, (n) => {
    if (n.isInline) found ??= type.isInSet(n.marks) ?? null
  })
  return found
}

/** Whether every text in the selection has `type` (the cursor's marks when nothing is selected). */
export function markActive(state: EditorState, type: MarkType): boolean {
  const { empty, $from, from, to } = state.selection
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks())
  let all = true
  let any = false
  state.doc.nodesBetween(from, to, (n) => {
    if (!n.isInline) return true
    any = true
    if (!type.isInSet(n.marks)) all = false
    return false
  })
  return any && all
}

export const setStyle = (styleId: string | null): Command => (state, dispatch) => patchParagraphs(state, dispatch, () => ({ styleId }))

/** ST_Jc: left, center, right, both. */
export const setAlign = (jc: string | null): Command => (state, dispatch) => patchParagraphs(state, dispatch, () => ({ jc }))

/** Removes direct formatting: the character formatting marks and the paragraphs' own alignment and indents (styles and lists stay). */
export const clearFormatting: Command = (state, dispatch) => {
  if (!dispatch) return true
  const { from, to, empty } = state.selection
  const tr = state.tr
  for (const name of FORMAT_MARKS) {
    const type = state.schema.marks[name]!
    if (!empty) tr.removeMark(from, to, type)
  }
  if (empty) tr.setStoredMarks((state.storedMarks ?? state.selection.$from.marks()).filter((m) => !(FORMAT_MARKS as readonly string[]).includes(m.type.name)))
  for (const p of selectedParagraphs(state)) tr.setNodeMarkup(p.pos, null, { ...p.node.attrs, jc: null, ind: null })
  dispatch(tr.scrollIntoView())
  return true
}

// ---------------------------------------------------------------- lists

export function listKindOf(session: DocxEditSession, attrs: ParagraphAttrs): ListKind | null {
  const num = effectiveNumbering(session.display, attrs)
  if (!num) return null
  const level = session.numbering().level(num.numId, num.ilvl)
  if (!level || level.format === 'none') return null
  return level.format === 'bullet' ? 'bullet' : 'number'
}

/** Ends the list on these paragraphs: numId 0 when their style brings one (§17.9.18), else no direct numbering. */
function noList(session: DocxEditSession, attrs: ParagraphAttrs): Partial<ParagraphAttrs> {
  const styled = session.docx.styles.paragraphStyle(attrs.styleId ?? undefined).pPr.numbering
  return styled?.numId && styled.numId !== '0' ? { numId: '0', ilvl: null } : { numId: null, ilvl: null }
}

/** Bullets or numbering on/off for the selected paragraphs; a new list continues the one right before it. */
export function toggleList(session: DocxEditSession, kind: ListKind): Command {
  return (state, dispatch) => {
    const paras = selectedParagraphs(state)
    if (paras.length === 0) return false
    if (!dispatch) return true
    const all = paras.every((p) => listKindOf(session, p.node.attrs as ParagraphAttrs) === kind)
    if (all) return patchParagraphs(state, dispatch, (p) => noList(session, p.node.attrs as ParagraphAttrs))
    const before = state.doc.resolve(paras[0]!.pos).nodeBefore
    const prev = before?.type.name === 'paragraph' ? (before.attrs as ParagraphAttrs) : null
    const prevNum = prev && listKindOf(session, prev) === kind ? effectiveNumbering(session.display, prev) : null
    const numId = prevNum?.numId ?? session.newList(kind)
    return patchParagraphs(state, dispatch, (p) => {
      const own = effectiveNumbering(session.display, p.node.attrs as ParagraphAttrs)
      return { numId, ilvl: own?.ilvl ?? prevNum?.ilvl ?? 0 }
    })
  }
}

const INDENT_STEP = 720

/** Indent (+1) or outdent (−1): a list item moves a level; another paragraph moves its start indent by half an inch. */
export function indent(session: DocxEditSession, dir: 1 | -1): Command {
  return (state, dispatch) =>
    patchParagraphs(state, dispatch, (p) => {
      const attrs = p.node.attrs as ParagraphAttrs
      const num = effectiveNumbering(session.display, attrs)
      if (num) return { numId: num.numId, ilvl: Math.max(0, Math.min(8, num.ilvl + dir)) }
      const startPt = resolvedParagraph(session.display, attrs).props.indent?.startPt ?? 0
      const start = Math.max(0, Math.round(startPt * 20) + dir * INDENT_STEP)
      const ind: IndentTwips = { ...(attrs.ind ?? {}), start }
      return { ind }
    })
}

/** In an empty list item, Enter (or Backspace at its start) ends the list instead. */
function endListItem(session: DocxEditSession, onlyEmpty: boolean): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection
    if (!empty || $from.parent.type.name !== 'paragraph') return false
    // Invisible markers (bookmark ends, empty runs) don't count as content.
    let before = true
    let blank = true
    $from.parent.forEach((child, offset) => {
      if (child.type.name === 'opaque' && child.attrs.kind === 'marker') return
      blank = false
      if (offset < $from.parentOffset) before = false
    })
    if (onlyEmpty ? !blank : !before) return false
    const attrs = $from.parent.attrs as ParagraphAttrs
    if (!listKindOf(session, attrs)) return false
    if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(), null, { ...attrs, ...noList(session, attrs) }))
    return true
  }
}

/**
 * Enter: the new paragraph keeps the paragraph's properties (Word does), at
 * the end of a paragraph whose style names a different next style
 * (w:next, §17.7.4.10) it takes that style instead.
 */
export function splitParagraph(session: DocxEditSession): Command {
  const split = splitBlockAs((node, atEnd) => {
    if (node.type.name !== 'paragraph') return null
    const attrs = node.attrs as ParagraphAttrs
    if (atEnd) {
      const style = session.docx.styles.styles.get(attrs.styleId ?? session.docx.styles.defaults.paragraph ?? '')
      const next = wa(wc(style?.source ?? null, 'next'), 'val')
      if (next && next !== style?.id) return { type: node.type, attrs: { ref: null, styleId: next, jc: null, ind: null, numId: null, ilvl: null } }
    }
    return { type: node.type, attrs }
  })
  return chainCommands(endListItem(session, true), split)
}

export const backspaceEndsList = (session: DocxEditSession): Command => endListItem(session, false)

// ---------------------------------------------------------------- links

/** The stretch of `mark` around the cursor, within its paragraph, or null. */
function markRange(state: EditorState, mark: Mark): { from: number; to: number } | null {
  const { $from } = state.selection
  const ranges: [number, number][] = []
  let pos = $from.start()
  let open = -1
  $from.parent.forEach((child) => {
    if (mark.isInSet(child.marks)) {
      if (open < 0) open = pos
    } else if (open >= 0) {
      ranges.push([open, pos])
      open = -1
    }
    pos += child.nodeSize
  })
  if (open >= 0) ranges.push([open, pos])
  const hit = ranges.find(([a, b]) => a <= $from.pos && $from.pos <= b)
  return hit ? { from: hit[0], to: hit[1] } : null
}

/** The link at the cursor or selection start. */
export function linkAt(state: EditorState): Mark | null {
  const type = state.schema.marks.link!
  const { $from, empty, from, to } = state.selection
  if (!empty) {
    let found: Mark | null = null
    state.doc.nodesBetween(from, to, (n) => {
      found ??= type.isInSet(n.marks) ?? null
    })
    return found
  }
  return type.isInSet($from.marks()) ?? ($from.nodeAfter ? (type.isInSet($from.nodeAfter.marks) ?? null) : null)
}

/**
 * Links the selection to `href` (an external URL, or "#bookmark" for a
 * place in the document); null unlinks. With no selection it edits the link
 * at the cursor, or inserts the URL as linked text.
 */
export function setLink(href: string | null): Command {
  return (state, dispatch) => {
    const type = state.schema.marks.link!
    let { from, to } = state.selection
    const current = linkAt(state)
    if (state.selection.empty && current) {
      const range = markRange(state, current)
      if (range) ({ from, to } = range)
    }
    if (!dispatch) return true
    const tr = state.tr
    const attrs = href === null ? null : href.startsWith('#') ? { href: null, anchor: href.slice(1), tooltip: null } : { href, anchor: null, tooltip: null }
    if (from === to) {
      if (!attrs || !href) return false
      const text = state.schema.text(href, [...state.selection.$from.marks().filter((m) => m.type !== type), type.create({ ...attrs, ref: null })])
      tr.replaceSelectionWith(text, false)
    } else {
      tr.removeMark(from, to, type)
      // Editing a link keeps its w:hyperlink (and what it carries); a new one gets its own.
      if (attrs) tr.addMark(from, to, type.create({ ...attrs, ref: current && current.attrs.ref ? current.attrs.ref : null }))
    }
    dispatch(tr.scrollIntoView())
    return true
  }
}

// ---------------------------------------------------------------- tables and pictures

export function insertTable(session: DocxEditSession, rows: number, cols: number): Command {
  return (state, dispatch) => {
    const { schema } = session
    if (!dispatch) return true
    const row = () => schema.nodes.table_row!.create(null, Array.from({ length: cols }, () => schema.nodes.table_cell!.create(null, schema.nodes.paragraph!.create())))
    const table = schema.nodes.table!.create(null, Array.from({ length: rows }, row))
    const { $to } = state.selection
    // After the paragraph (or table) the cursor is in, at the top level of its container.
    const depth = $to.depth > 0 ? $to.depth : 1
    const at = $to.after(depth)
    const tr = state.tr.insert(at, table)
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3)))
    dispatch(tr.scrollIntoView())
    return true
  }
}

export const tableCommands = {
  addRow: addRowAfter,
  addColumn: addColumnAfter,
  deleteRow,
  deleteColumn,
  inTable: isInTable,
  nextCell: goToNextCell(1),
  previousCell: goToNextCell(-1),
}

/** Inserts a picture (PNG, JPEG or GIF) at the cursor, at most as wide as the text. */
export function insertImage(session: DocxEditSession, pic: { bytes: Uint8Array; contentType: string; widthPt: number; heightPt: number; name: string }): Command {
  return (state, dispatch) => {
    if (!dispatch) return true
    const { part, rId } = session.addImage(pic.bytes, pic.contentType)
    const scale = pic.widthPt > session.textWidthPt ? session.textWidthPt / pic.widthPt : 1
    const node = session.schema.nodes.image!.create({
      part,
      rId,
      contentType: pic.contentType,
      widthPt: Math.round(pic.widthPt * scale * 100) / 100,
      heightPt: Math.round(pic.heightPt * scale * 100) / 100,
      alt: pic.name,
      name: pic.name,
    })
    dispatch(state.tr.replaceSelectionWith(node, true).scrollIntoView())
    return true
  }
}

/** A tab character as Word's w:tab. */
export const insertTab: Command = (state, dispatch) => {
  if (state.selection.$from.parent.type.name !== 'paragraph') return false
  if (dispatch) dispatch(state.tr.replaceSelectionWith(state.schema.nodes.tab!.create(), true).scrollIntoView())
  return true
}

export const insertNode =
  (name: 'hard_break' | 'page_break'): Command =>
  (state, dispatch) => {
    if (state.selection.$from.parent.type.name !== 'paragraph') return false
    if (dispatch) dispatch(state.tr.replaceSelectionWith(state.schema.nodes[name]!.create(), true).scrollIntoView())
    return true
  }

/** Whether the paragraph(s) at the cursor are list items: Tab indents them instead of typing a tab. */
export const inList = (session: DocxEditSession, state: EditorState) => selectedParagraphs(state).some((p) => listKindOf(session, p.node.attrs as ParagraphAttrs) !== null)
