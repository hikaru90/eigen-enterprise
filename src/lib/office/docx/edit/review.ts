import type { DocxEditSession } from './session'
import type { Mark, Node as PMNode, ResolvedPos } from 'prosemirror-model'
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state'
import { AddMarkStep, Mapping, RemoveMarkStep, ReplaceStep } from 'prosemirror-transform'
import { initialsOf, wordDate, type CommentData } from '../comments'
import { wc } from '../xml'
import {
  FORMAT_MARKS,
  formatMarks,
  type MarkData,
  type ParagraphAttrs,
  type RevisionInfo,
} from './schema'
import { markData, paragraphAttrs } from './to-pm'

/**
 * Review in the editor (ECMA-376 Part 1 §17.13): comments and tracked
 * changes as ProseMirror data, written back by the serializer.
 *
 * - Tracked changes are marks: `insertion` (w:ins / w:moveTo), `deletion`
 *   (w:del / w:moveFrom, the text stays and is struck through) and
 *   `formatChange` (w:rPrChange, with the formatting before). Paragraphs
 *   carry w:pPrChange and paragraph-mark revisions as attrs.
 * - With Track changes on, `trackTransaction` rewrites each edit before it
 *   is applied: deleted text gets a deletion mark instead of going (your
 *   own pending insertion goes for real), inserted text gets an insertion
 *   mark, and formatting changes record what the text had before.
 * - Comments: their data lives in the document's `comments` attr; their
 *   anchors are `comment_mark` nodes in the text.
 *
 * Every review command runs with TRACK_SKIP, so it is never tracked itself.
 */

export const TRACK_SKIP = 'docx-track-skip'

/** Who is reviewing: the signed-in member (never anonymous). */
export type Reviewer = { name: string; initials: string }

export const reviewerOf = (author: { name: string }): Reviewer => ({
  name: author.name,
  initials: initialsOf(author.name),
})

type Ids = { newId(): string; now(): string }

const isFormat = (name: string) => (FORMAT_MARKS as readonly string[]).includes(name)

/** Inline nodes a deletion can strike (anchors and paragraph-level kept XML stay as they are). */
const strikable = (n: PMNode) =>
  n.isInline &&
  n.type.name !== 'comment_mark' &&
  !(n.type.name === 'opaque' && n.attrs.level === 'para')

function revisionAttrs(user: Reviewer, ids: Ids): RevisionInfo {
  return { id: ids.newId(), author: user.name, date: ids.now() }
}

/** The mark of `type` by `user` right before or after `$pos`, to extend instead of starting a new change. */
function adjacent($pos: ResolvedPos, type: string, user: Reviewer): Mark | null {
  for (const n of [$pos.nodeBefore, $pos.nodeAfter]) {
    const m = n?.marks.find((x) => x.type.name === type)
    if (m && m.attrs.author === user.name) return m
  }
  return null
}

/**
 * The tracked form of `tr` (made against `state`): the same edits, recorded
 * as revisions by `user`.
 */
export function trackTransaction(
  state: EditorState,
  tr: Transaction,
  user: Reviewer,
  ids: Ids,
): Transaction {
  const schema = state.schema
  const ins = schema.marks.insertion!
  const del = schema.marks.deletion!
  const fc = schema.marks.formatChange!
  const out = state.tr
  /** Positions in the original transaction's current document → `out`'s. */
  let map = new Mapping()
  let cursor: number | null = null
  tr.steps.forEach((step) => {
    const start = out.steps.length
    if (step instanceof ReplaceStep) {
      const from = map.map(step.from, 1)
      const to = Math.max(from, map.map(step.to, -1))
      // Deleted content: struck through, except the reviewer's own pending insertions, which simply go.
      const ranges: { from: number; to: number; own: boolean }[] = []
      out.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isInline) return true
        const s = Math.max(pos, from)
        const e = Math.min(pos + node.nodeSize, to)
        if (e <= s || !strikable(node) || del.isInSet(node.marks)) return false
        const inserted = ins.isInSet(node.marks)
        ranges.push({ from: s, to: e, own: !!inserted && inserted.attrs.author === user.name })
        return false
      })
      if (ranges.length) {
        const reuse =
          adjacent(out.doc.resolve(from), 'deletion', user) ??
          adjacent(out.doc.resolve(to), 'deletion', user)
        const mark = reuse ?? del.create(revisionAttrs(user, ids))
        for (const r of [...ranges].reverse()) {
          if (r.own) out.delete(r.from, r.to)
          else out.addMark(r.from, r.to, mark)
        }
      }
      const at = out.mapping.slice(start).map(to, -1)
      if (step.slice.size > 0) {
        const reuse = adjacent(out.doc.resolve(at), 'insertion', user)
        const k = out.steps.length
        out.replace(at, at, step.slice)
        const m = out.mapping.slice(k)
        const s = m.map(at, -1)
        const e = m.map(at, 1)
        if (e > s) {
          out.removeMark(s, e, del)
          out.removeMark(s, e, fc)
          out.addMark(s, e, reuse ?? ins.create(revisionAttrs(user, ids)))
        }
        cursor = e
      } else {
        const backwards = state.selection.empty && state.selection.head === step.to
        cursor = backwards || !state.selection.empty ? out.mapping.slice(start).map(from, -1) : at
      }
    } else if (
      (step instanceof AddMarkStep || step instanceof RemoveMarkStep) &&
      isFormat(step.mark.type.name)
    ) {
      const mapped = step.map(map)
      if (mapped) {
        const s = mapped as AddMarkStep | RemoveMarkStep
        // What the text looked like before: recorded once, on text not already changed or newly inserted.
        const before: { from: number; to: number; marks: MarkData[] }[] = []
        out.doc.nodesBetween(s.from, s.to, (node, pos) => {
          if (!node.isInline) return true
          if (!fc.isInSet(node.marks) && !ins.isInSet(node.marks)) {
            before.push({
              from: Math.max(pos, s.from),
              to: Math.min(pos + node.nodeSize, s.to),
              marks: formatMarks(node.marks).map(markData),
            })
          }
          return false
        })
        out.step(s)
        if (before.length) {
          const info = revisionAttrs(user, ids)
          for (const b of before) out.addMark(b.from, b.to, fc.create({ ...info, before: b.marks }))
        }
      }
    } else {
      const mapped = step.map(map)
      if (mapped) out.maybeStep(mapped)
    }
    const next = new Mapping()
    next.appendMap(step.getMap().invert())
    next.appendMapping(map)
    next.appendMapping(out.mapping.slice(start))
    map = next
  })
  if (cursor !== null)
    out.setSelection(TextSelection.near(out.doc.resolve(Math.min(cursor, out.doc.content.size))))
  else if (tr.selectionSet) out.setSelection(tr.selection.map(out.doc, map))
  if (tr.storedMarksSet) out.setStoredMarks(tr.storedMarks)
  if (tr.scrolledIntoView) out.scrollIntoView()
  for (const key of ['addToHistory', 'uiEvent', 'paste']) {
    const v = tr.getMeta(key)
    if (v !== undefined) out.setMeta(key, v)
  }
  out.setTime(tr.time)
  return out
}

// ---------------------------------------------------------------- the changes in a document

export type ChangeKind =
  'insert' | 'delete' | 'format' | 'paragraph' | 'mark-insert' | 'mark-delete'

export type TrackedChange = {
  kind: ChangeKind
  id: string
  author: string | null
  date: string | null
  move: boolean
  from: number
  to: number
  /** The paragraph's position, for paragraph-level changes. */
  pos: number | null
  /** The mark, for text changes. */
  mark: Mark | null
}

const TEXT_KINDS: [string, ChangeKind][] = [
  ['insertion', 'insert'],
  ['deletion', 'delete'],
  ['formatChange', 'format'],
]

/** Every tracked change, in document order (a run of text with the same mark is one change). */
export function trackedChanges(doc: PMNode): TrackedChange[] {
  const out: TrackedChange[] = []
  const open = new Map<string, TrackedChange>()
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') {
      const a = node.attrs as ParagraphAttrs
      if (a.pChange)
        out.push({
          kind: 'paragraph',
          ...a.pChange,
          move: false,
          from: pos + 1,
          to: pos + node.nodeSize - 1,
          pos,
          mark: null,
        })
      if (a.markChange) {
        const end = pos + node.nodeSize - 1
        out.push({
          kind: a.markChange.kind === 'insert' ? 'mark-insert' : 'mark-delete',
          id: a.markChange.id,
          author: a.markChange.author,
          date: a.markChange.date,
          move: false,
          from: end,
          to: end,
          pos,
          mark: null,
        })
      }
      return true
    }
    if (!node.isInline) return true
    for (const [type, kind] of TEXT_KINDS) {
      const m = node.marks.find((x) => x.type.name === type)
      const cur = open.get(type)
      if (m && cur && cur.mark!.eq(m) && cur.to === pos) {
        cur.to = pos + node.nodeSize
        continue
      }
      if (m) {
        const c: TrackedChange = {
          kind,
          id: m.attrs.id as string,
          author: m.attrs.author as string | null,
          date: m.attrs.date as string | null,
          move: !!m.attrs.move,
          from: pos,
          to: pos + node.nodeSize,
          pos: null,
          mark: m,
        }
        out.push(c)
        open.set(type, c)
      } else open.delete(type)
    }
    return false
  })
  return out.sort((a, b) => a.from - b.from)
}

/** The change the selection is on (the first one it touches), or null. */
export function changeAt(
  state: EditorState,
  changes = trackedChanges(state.doc),
): TrackedChange | null {
  const { from, to } = state.selection
  return changes.find((c) => c.from <= to && c.to >= from) ?? null
}

function applyDecision(
  session: DocxEditSession,
  tr: Transaction,
  c: TrackedChange,
  accept: boolean,
) {
  const schema = tr.doc.type.schema
  const para = (pos: number) => tr.doc.nodeAt(pos)!
  const setPara = (pos: number, patch: Partial<ParagraphAttrs>) =>
    tr.setNodeMarkup(pos, null, { ...para(pos).attrs, ...patch })
  const joinNext = (pos: number) => {
    const end = pos + para(pos).nodeSize
    if (tr.doc.nodeAt(end)?.type.name === 'paragraph') tr.join(end)
  }
  switch (c.kind) {
    case 'insert':
      if (accept) tr.removeMark(c.from, c.to, c.mark!)
      else tr.delete(c.from, c.to)
      break
    case 'delete':
      if (accept) tr.delete(c.from, c.to)
      else tr.removeMark(c.from, c.to, c.mark!)
      break
    case 'format':
      tr.removeMark(c.from, c.to, c.mark!)
      if (!accept) {
        for (const name of FORMAT_MARKS) tr.removeMark(c.from, c.to, schema.marks[name]!)
        for (const d of c.mark!.attrs.before as MarkData[])
          tr.addMark(c.from, c.to, schema.markFromJSON(d))
      }
      break
    case 'paragraph': {
      if (accept) {
        setPara(c.pos!, { pChange: null })
        break
      }
      const attrs = para(c.pos!).attrs as ParagraphAttrs
      const el = session.registry.of(attrs.ref, 'paragraph')?.el ?? null
      const recorded = wc(wc(wc(el, 'pPr'), 'pPrChange'), 'pPr')
      setPara(c.pos!, {
        ...paragraphAttrs(recorded, attrs.ref),
        pChange: null,
        revertPPr: true,
        markChange: attrs.markChange ?? null,
      })
      break
    }
    case 'mark-insert':
      setPara(c.pos!, { markChange: null })
      if (!accept) joinNext(c.pos!)
      break
    case 'mark-delete':
      setPara(c.pos!, { markChange: null })
      if (accept) joinNext(c.pos!)
      break
  }
}

/** Accepts or rejects one change (as found in the current state). */
export function decideChange(
  session: DocxEditSession,
  change: TrackedChange,
  accept: boolean,
): Command {
  return (state, dispatch) => {
    if (!dispatch) return true
    const tr = state.tr.setMeta(TRACK_SKIP, true)
    applyDecision(session, tr, change, accept)
    dispatch(tr.scrollIntoView())
    return true
  }
}

/** Accepts or rejects every change, last first so earlier positions stay put. */
export function decideAll(session: DocxEditSession, accept: boolean): Command {
  return (state, dispatch) => {
    const changes = trackedChanges(state.doc)
    if (changes.length === 0) return false
    if (!dispatch) return true
    const tr = state.tr.setMeta(TRACK_SKIP, true)
    for (const c of [...changes].sort((a, b) => b.from - a.from || (b.pos === null ? 1 : -1)))
      applyDecision(session, tr, c, accept)
    dispatch(tr.scrollIntoView())
    return true
  }
}

/** Selects the next (or previous) change after (before) the selection, wrapping around. */
export function gotoChange(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const changes = trackedChanges(state.doc)
    if (changes.length === 0) return false
    const { from, to } = state.selection
    const target =
      dir > 0
        ? (changes.find((c) => c.from > from || (c.from === from && c.to > to)) ?? changes[0]!)
        : ([...changes].reverse().find((c) => c.from < from) ?? changes.at(-1)!)
    if (dispatch)
      dispatch(
        state.tr
          .setSelection(TextSelection.create(state.doc, target.from, target.to))
          .scrollIntoView(),
      )
    return true
  }
}

/** Turns Track changes on or off (settings.xml w:trackRevisions). */
export function setTracking(on: boolean): Command {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.setDocAttribute('trackRevisions', on).setMeta(TRACK_SKIP, true))
    return true
  }
}

// ---------------------------------------------------------------- comments

export const commentsOf = (doc: PMNode) => doc.attrs.comments as CommentData[]

/** The marks an anchor at `$pos` takes so it doesn't split the link or change around it. */
const anchorMarks = ($pos: ResolvedPos) =>
  $pos
    .marks()
    .filter(
      (m) => m.type.name === 'link' || m.type.name === 'insertion' || m.type.name === 'deletion',
    )

/** Adds a comment on the selected text. */
export function addComment(session: DocxEditSession, user: Reviewer, text: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    const $from = state.doc.resolve(from)
    const $to = state.doc.resolve(to)
    if (empty || !$from.parent.inlineContent || !$to.parent.inlineContent || !text.trim())
      return false
    if (!dispatch) return true
    const id = session.newId()
    const paraId = session.newParaId()
    const data: CommentData = {
      id,
      author: user.name,
      initials: user.initials,
      date: wordDate(new Date()),
      text: text.trim(),
      parentId: null,
      done: false,
      paraId,
      durableId: session.newParaId(),
    }
    const node = (edge: string, $pos: ResolvedPos) =>
      state.schema.nodes.comment_mark!.create(
        { id, edge, level: 'para' },
        undefined,
        anchorMarks($pos),
      )
    const tr = state.tr.setMeta(TRACK_SKIP, true)
    tr.insert(to, [node('end', $to), node('ref', $to)])
    tr.insert(from, node('start', $from))
    tr.setDocAttribute('comments', [...commentsOf(state.doc), data])
    dispatch(tr)
    return true
  }
}

/** The positions of a comment's anchors, by edge. */
function anchorsOf(doc: PMNode, id: string): { edge: string; pos: number; node: PMNode }[] {
  const out: { edge: string; pos: number; node: PMNode }[] = []
  doc.descendants((n, pos) => {
    if (n.type.name === 'comment_mark' && n.attrs.id === id)
      out.push({ edge: n.attrs.edge as string, pos, node: n })
    return true
  })
  return out
}

/** A reply in the comment's thread: anchored next to the comment's own anchors, as Word does. */
export function replyToComment(
  session: DocxEditSession,
  user: Reviewer,
  parentId: string,
  text: string,
): Command {
  return (state, dispatch) => {
    const list = commentsOf(state.doc)
    const parent = list.find((c) => c.id === parentId)
    if (!parent || !text.trim()) return false
    if (!dispatch) return true
    const id = session.newId()
    const tr = state.tr.setMeta(TRACK_SKIP, true)
    // Replies hang off the thread's first comment, which needs a paragraph id for the link (w15:paraIdParent).
    const root = parent.parentId ? (list.find((c) => c.id === parent.parentId) ?? parent) : parent
    const rootPara = root.paraId ?? session.newParaId()
    const data: CommentData = {
      id,
      author: user.name,
      initials: user.initials,
      date: wordDate(new Date()),
      text: text.trim(),
      parentId: root.id,
      done: false,
      paraId: session.newParaId(),
      durableId: session.newParaId(),
    }
    for (const a of anchorsOf(state.doc, root.id).reverse()) {
      tr.insert(
        a.pos + a.node.nodeSize,
        state.schema.nodes.comment_mark!.create(
          { id, edge: a.edge, level: 'para' },
          undefined,
          a.node.marks,
        ),
      )
    }
    tr.setDocAttribute('comments', [
      ...list.map((c) => (c.id === root.id ? { ...c, paraId: rootPara } : c)),
      data,
    ])
    dispatch(tr)
    return true
  }
}

function patchComment(id: string, patch: (c: CommentData) => CommentData | null): Command {
  return (state, dispatch) => {
    const list = commentsOf(state.doc)
    const c = list.find((x) => x.id === id)
    if (!c) return false
    const next = patch(c)
    if (!next) return false
    if (dispatch)
      dispatch(
        state.tr
          .setDocAttribute(
            'comments',
            list.map((x) => (x.id === id ? next : x)),
          )
          .setMeta(TRACK_SKIP, true),
      )
    return true
  }
}

/** Edits the text of one of your own comments. */
export const editComment = (user: Reviewer, id: string, text: string): Command =>
  patchComment(id, (c) =>
    c.author === user.name && text.trim() ? { ...c, text: text.trim() } : null,
  )

/** Resolves or reopens a thread (w15:done). A comment from before threads gets its paragraph id now. */
export const setCommentDone = (session: DocxEditSession, id: string, done: boolean): Command =>
  patchComment(id, (c) =>
    c.done === done ? null : { ...c, done, paraId: c.paraId ?? session.newParaId() },
  )

/** Deletes a comment with its replies and their anchors. */
export function deleteComment(id: string): Command {
  return (state, dispatch) => {
    const list = commentsOf(state.doc)
    if (!list.some((c) => c.id === id)) return false
    if (!dispatch) return true
    const gone = new Set([id])
    for (let grew = true; grew;) {
      grew = false
      for (const c of list) {
        if (c.parentId && gone.has(c.parentId) && !gone.has(c.id)) {
          gone.add(c.id)
          grew = true
        }
      }
    }
    const tr = state.tr.setMeta(TRACK_SKIP, true)
    const anchors: number[] = []
    state.doc.descendants((n, pos) => {
      if (n.type.name === 'comment_mark' && gone.has(n.attrs.id as string)) anchors.push(pos)
      return true
    })
    for (const pos of anchors.reverse()) tr.delete(pos, pos + 1)
    tr.setDocAttribute(
      'comments',
      list.filter((c) => !gone.has(c.id)),
    )
    dispatch(tr)
    return true
  }
}

/** The comments whose ranges hold `pos`. */
export function commentsAt(doc: PMNode, pos: number): string[] {
  const open: string[] = []
  let found: string[] = []
  doc.descendants((n, p) => {
    if (p > pos) return false
    if (n.type.name === 'comment_mark') {
      const id = n.attrs.id as string
      if (n.attrs.edge === 'start') open.push(id)
      else if (n.attrs.edge === 'end' && open.includes(id)) open.splice(open.indexOf(id), 1)
    } else if (n.isInline && p <= pos && pos <= p + n.nodeSize) found = [...open]
    return true
  })
  return found
}
