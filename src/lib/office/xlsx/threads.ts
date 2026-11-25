import type { RefEdit } from './shift'
import { strToU8 } from 'fflate'
import { relsPartOf } from '../ooxml/package'
import {
  editIfChanged,
  NS_THREADED,
  readNotes,
  REL_THREADED,
  removeLegacyComment,
  threadedPartOf,
  writeLegacyComment,
  type SheetDocSource,
} from './notes'
import { cellName, parseCell } from './ref'
import { editRange } from './shift'
import { relativeTarget, XlsxError, type SheetInfo, type Workbook } from './workbook'
import { all, kid, kids, textOf } from './xml'

/**
 * Threaded comments (Excel 365's "Comments": [MS-XLSX] threadedComments and
 * persons parts): a thread on a cell is its first comment plus replies
 * (`parentId`), resolved on the first comment (`done="1"`); each comment
 * names its author in the workbook's person list, and mentions name people
 * there too. For older Excel every thread also keeps a legacy comment on its
 * cell (author `tc={thread id}`, the thread as text; ./notes.ts) — written
 * along with every change, as Excel does, so either version shows it.
 *
 * Company members are persons with `providerId="None"` and their member id
 * as `userId`: the author of a comment, and whom a mention names.
 */

export const REL_PERSON = 'http://schemas.microsoft.com/office/2017/10/relationships/person'
const CT_THREADED = 'application/vnd.ms-excel.threadedcomments+xml'
const CT_PERSON = 'application/vnd.ms-excel.person+xml'
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
export const MEMBER_PROVIDER = 'None'

export type Person = { id: string; name: string; userId: string | null; providerId: string | null }
/** Someone writing or mentioned: a company member (id, shown name). */
export type Member = { id: string; name: string }

export type ThreadComment = {
  id: string
  author: string
  /** The author's member id, when the author is a company member. */
  authorId: string | null
  /** ISO date-time. */
  at: string
  text: string
  mentions: Array<{ name: string; memberId: string | null; start: number; length: number }>
}

export type Thread = {
  /** The first comment's id. */
  id: string
  ref: string
  row: number
  col: number
  resolved: boolean
  /** The first comment, then the replies in order. */
  comments: ThreadComment[]
}

export type ThreadOp =
  | {
      op: 'add_comment'
      sheet: string
      ref: string
      text: string
      author: Member
      mentions?: Member[]
      /** ISO date-time (tests); default: now. */
      now?: string
    }
  | {
      op: 'reply_comment'
      sheet: string
      /** The thread (its first comment's id). */
      thread: string
      text: string
      author: Member
      mentions?: Member[]
      now?: string
    }
  | { op: 'edit_comment'; sheet: string; id: string; text: string; author: Member; mentions?: Member[] }
  | { op: 'resolve_comment'; sheet: string; thread: string; resolved: boolean }
  /** A thread's first comment deletes the thread; a reply only itself (its author's). */
  | { op: 'delete_comment'; sheet: string; id: string; author: Member }

const newId = () => `{${globalThis.crypto.randomUUID().toUpperCase()}}`

// ---------------------------------------------------------------------------
// Persons

export function personsPart(wb: Workbook): string | null {
  const rel = wb.pkg.relationships(wb.part).find((r) => r.type === REL_PERSON && r.part && wb.pkg.has(r.part))
  return rel?.part ?? null
}

export function readPersons(wb: Workbook): Person[] {
  const part = personsPart(wb)
  if (!part) return []
  return all(wb.pkg.xml(part), 'person', NS_THREADED).map((p) => ({
    id: p.getAttribute('id') ?? '',
    name: p.getAttribute('displayName') ?? '',
    userId: p.getAttribute('userId'),
    providerId: p.getAttribute('providerId'),
  }))
}

const memberOf = (p: Person | undefined) => (p && p.providerId === MEMBER_PROVIDER && p.userId ? p.userId : null)

/** The person id of a member (added to the person list when new; the name follows the member's). */
function personFor(wb: Workbook, m: Member): string {
  let part = personsPart(wb)
  if (!part) {
    part = '/xl/persons/person.xml'
    for (let n = 2; wb.pkg.has(part); n++) part = `/xl/persons/person${n}.xml`
    wb.write(
      part,
      strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<personList xmlns="${NS_THREADED}" xmlns:x="${NS_MAIN}"/>`,
      ),
      CT_PERSON,
    )
    wb.touch(relsPartOf(wb.part))
    wb.pkg.addRelationship(wb.part, REL_PERSON, relativeTarget(wb.part, part))
  }
  const doc = wb.edit(part)
  const root = doc.documentElement!
  const have = all(doc, 'person', NS_THREADED).find(
    (p) => p.getAttribute('providerId') === MEMBER_PROVIDER && p.getAttribute('userId') === m.id,
  )
  if (have) {
    if (m.name && have.getAttribute('displayName') !== m.name) have.setAttribute('displayName', m.name)
    return have.getAttribute('id')!
  }
  const p = doc.createElementNS(NS_THREADED, root.prefix ? `${root.prefix}:person` : 'person')
  const id = newId()
  p.setAttribute('displayName', m.name)
  p.setAttribute('id', id)
  p.setAttribute('userId', m.id)
  p.setAttribute('providerId', MEMBER_PROVIDER)
  root.appendChild(p)
  return id
}

// ---------------------------------------------------------------------------
// Reading

export function readThreads(wb: Workbook, info: SheetInfo): Thread[] {
  const part = threadedPartOf(wb, info)
  if (!part) return []
  const persons = new Map(readPersons(wb).map((p) => [p.id, p]))
  const byId = new Map<string, Thread>()
  const out: Thread[] = []
  const els = all(wb.pkg.xml(part), 'threadedComment', NS_THREADED)
  const model = (el: Element): ThreadComment => {
    const person = persons.get(el.getAttribute('personId') ?? '')
    const mentions = kid(el, 'mentions', NS_THREADED)
    return {
      id: el.getAttribute('id') ?? '',
      author: person?.name ?? '',
      authorId: memberOf(person),
      at: el.getAttribute('dT') ?? '',
      text: textOf(kid(el, 'text', NS_THREADED)),
      mentions: (mentions ? kids(mentions, 'mention', NS_THREADED) : []).map((x) => {
        const who = persons.get(x.getAttribute('mentionpersonId') ?? '')
        return {
          name: who?.name ?? '',
          memberId: memberOf(who),
          start: Number(x.getAttribute('startIndex') ?? 0),
          length: Number(x.getAttribute('length') ?? 0),
        }
      }),
    }
  }
  for (const el of els) {
    if (el.getAttribute('parentId')) continue
    const a = parseCell(el.getAttribute('ref') ?? '')
    if (!a) continue
    const t: Thread = {
      id: el.getAttribute('id') ?? '',
      ref: cellName(a),
      row: a.row,
      col: a.col,
      resolved: el.getAttribute('done') === '1' || el.getAttribute('done') === 'true',
      comments: [model(el)],
    }
    byId.set(t.id, t)
    out.push(t)
  }
  for (const el of els) {
    const parent = el.getAttribute('parentId')
    if (parent) byId.get(parent)?.comments.push(model(el))
  }
  return out
}

// ---------------------------------------------------------------------------
// Writing

function ensureThreadedPart(wb: Workbook, info: SheetInfo): string {
  const have = threadedPartOf(wb, info)
  if (have) return have
  let n = 1
  while (wb.pkg.has(`/xl/threadedComments/threadedComment${n}.xml`)) n++
  const part = `/xl/threadedComments/threadedComment${n}.xml`
  wb.write(
    part,
    strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<ThreadedComments xmlns="${NS_THREADED}" xmlns:x="${NS_MAIN}"/>`,
    ),
    CT_THREADED,
  )
  wb.touch(relsPartOf(info.part))
  wb.pkg.addRelationship(info.part, REL_THREADED, relativeTarget(info.part, part))
  return part
}

/** The text and its mentions: each member's "@Name" in the text (added at the end when the text lacks it). */
function withMentions(text: string, mentions: Member[]): { text: string; at: Array<{ m: Member; start: number; length: number }> } {
  let out = text
  const at: Array<{ m: Member; start: number; length: number }> = []
  const taken = new Set<number>()
  const isBoundary = (s: string, end: number) => end >= s.length || !/[\p{L}\p{N}_]/u.test(s[end]!)
  for (const m of mentions) {
    const tag = `@${m.name}`
    let i = out.indexOf(tag)
    while (i >= 0 && (taken.has(i) || !isBoundary(out, i + tag.length))) i = out.indexOf(tag, i + 1)
    if (i < 0) {
      out = `${out}${out.endsWith(' ') || out === '' ? '' : ' '}${tag}`
      i = out.length - tag.length
    }
    taken.add(i)
    at.push({ m, start: i, length: tag.length })
  }
  return { text: out, at }
}

function writeBody(wb: Workbook, el: Element, text: string, mentions: Member[]) {
  const doc = el.ownerDocument!
  const prefix = doc.documentElement!.prefix
  const make = (local: string) => doc.createElementNS(NS_THREADED, prefix ? `${prefix}:${local}` : local)
  for (const k of kids(el, undefined)) if (k.localName === 'text' || k.localName === 'mentions') el.removeChild(k)
  const body = withMentions(text, mentions)
  const t = make('text')
  t.appendChild(doc.createTextNode(body.text))
  el.insertBefore(t, el.firstChild)
  if (body.at.length > 0) {
    const ms = make('mentions')
    for (const x of body.at) {
      const m = make('mention')
      m.setAttribute('mentionpersonId', personFor(wb, x.m))
      m.setAttribute('mentionId', newId())
      m.setAttribute('startIndex', String(x.start))
      m.setAttribute('length', String(x.length))
      ms.appendChild(m)
    }
    t.parentNode!.insertBefore(ms, t.nextSibling)
  }
}

function checkText(text: string) {
  if (text.trim() === '') throw new XlsxError('A comment needs text.')
  if (text.length > 32_767) throw new XlsxError('A comment can hold at most 32767 characters.')
}

/** The thread as older Excel shows it: its legacy comment's text. */
function standInText(t: Thread): string {
  const lines = ['[Threaded comment]', '', 'This cell has a comment thread; a current version of Excel shows it and lets you reply.', '']
  t.comments.forEach((c, i) => {
    lines.push(i === 0 ? 'Comment:' : 'Reply:')
    lines.push(`    ${c.text.replace(/\n/g, '\n    ')}`)
  })
  return lines.join('\n')
}

/** Rewrites the thread's legacy stand-in after a change. */
function syncStandIn(wb: Workbook, info: SheetInfo, sheetDoc: SheetDocSource, ref: string) {
  const t = readThreads(wb, info).find((x) => x.ref === ref)
  if (!t) removeLegacyComment(wb, info, sheetDoc, ref)
  else writeLegacyComment(wb, info, sheetDoc, ref, standInText(t), `tc=${t.id}`)
}

function dropEmptyThreadedPart(wb: Workbook, info: SheetInfo) {
  const part = threadedPartOf(wb, info)
  if (part && all(wb.pkg.xml(part), 'threadedComment', NS_THREADED).length === 0) {
    const rel = wb.pkg.relationships(info.part).find((r) => r.part === part)
    if (rel) {
      const rels = wb.edit(relsPartOf(info.part))
      for (const el of kids(rels.documentElement!, 'Relationship', 'http://schemas.openxmlformats.org/package/2006/relationships'))
        if (el.getAttribute('Id') === rel.id) rels.documentElement!.removeChild(el)
    }
    wb.remove(part)
  }
}

export function runThreadOp(wb: Workbook, op: ThreadOp, sheetDoc: SheetDocSource): string | undefined {
  const info = wb.requireWorksheet(op.sheet)
  const threads = readThreads(wb, info)
  const find = (id: string) => {
    for (const t of threads) {
      const i = t.comments.findIndex((c) => c.id === id)
      if (i >= 0) return { t, i }
    }
    throw new XlsxError(`This sheet has no comment ${id}.`)
  }
  const els = () => {
    const part = threadedPartOf(wb, info)
    return part ? all(wb.edit(part), 'threadedComment', NS_THREADED) : []
  }
  const now = (o: { now?: string }) => o.now ?? new Date().toISOString()

  if (op.op === 'add_comment' || op.op === 'reply_comment') {
    checkText(op.text)
    let ref: string
    let parent: string | null = null
    if (op.op === 'add_comment') {
      const a = parseCell(op.ref)
      if (!a) throw new XlsxError(`“${op.ref}” is not a cell address (like A1).`)
      ref = cellName(a)
      const there = threads.find((t) => t.ref === ref)
      if (there) throw new XlsxError(`${info.name}!${ref} already has a comment thread: reply to it.`)
      if (readNotes(wb, info).some((n) => n.ref === ref))
        throw new XlsxError(`${info.name}!${ref} has a note; a cell holds a note or a comment, not both.`)
    } else {
      const t = threads.find((x) => x.id === op.thread)
      if (!t) throw new XlsxError(`This sheet has no comment thread ${op.thread}.`)
      ref = t.ref
      parent = t.id
    }
    const part = ensureThreadedPart(wb, info)
    const doc = wb.edit(part)
    const root = doc.documentElement!
    const el = doc.createElementNS(NS_THREADED, root.prefix ? `${root.prefix}:threadedComment` : 'threadedComment')
    const id = newId()
    el.setAttribute('ref', ref)
    el.setAttribute('dT', now(op))
    el.setAttribute('personId', personFor(wb, op.author))
    el.setAttribute('id', id)
    if (parent) el.setAttribute('parentId', parent)
    writeBody(wb, el, op.text, op.mentions ?? [])
    // Replies follow their thread's last comment.
    const list = all(doc, 'threadedComment', NS_THREADED)
    const last = parent ? [...list].reverse().find((x) => x.getAttribute('id') === parent || x.getAttribute('parentId') === parent) : null
    if (last) root.insertBefore(el, last.nextSibling)
    else root.appendChild(el)
    syncStandIn(wb, info, sheetDoc, ref)
    return id
  }
  if (op.op === 'edit_comment') {
    checkText(op.text)
    const { t, i } = find(op.id)
    const c = t.comments[i]!
    if (c.authorId !== op.author.id)
      throw new XlsxError(`Only ${c.author || 'its author'} can edit this comment.`)
    const el = els().find((x) => x.getAttribute('id') === op.id)!
    writeBody(wb, el, op.text, op.mentions ?? [])
    syncStandIn(wb, info, sheetDoc, t.ref)
    return
  }
  if (op.op === 'resolve_comment') {
    const t = threads.find((x) => x.id === op.thread)
    if (!t) throw new XlsxError(`This sheet has no comment thread ${op.thread}.`)
    const el = els().find((x) => x.getAttribute('id') === t.id)!
    if (op.resolved) el.setAttribute('done', '1')
    else el.removeAttribute('done')
    return
  }
  const { t, i } = find(op.id)
  const doomed = new Set(i === 0 ? t.comments.map((c) => c.id) : [op.id])
  if (i > 0 && t.comments[i]!.authorId !== op.author.id)
    throw new XlsxError(`Only ${t.comments[i]!.author || 'its author'} can delete this reply; delete the whole thread instead.`)
  for (const el of els()) if (doomed.has(el.getAttribute('id') ?? '')) el.parentNode!.removeChild(el)
  dropEmptyThreadedPart(wb, info)
  syncStandIn(wb, info, sheetDoc, t.ref)
}

// ---------------------------------------------------------------------------
// Moving with the cells

/** Threads follow inserted/deleted rows or columns; a thread on a deleted cell goes. */
export function shiftThreads(wb: Workbook, info: SheetInfo, edit: RefEdit) {
  const part = threadedPartOf(wb, info)
  if (!part) return
  editIfChanged(wb, part, (doc) => {
    let changed = false
    for (const el of all(doc, 'threadedComment', NS_THREADED)) {
      const a = parseCell(el.getAttribute('ref') ?? '')
      if (!a) continue
      const moved = editRange({ top: a.row, bottom: a.row, left: a.col, right: a.col }, info.name, edit)
      if (!moved) el.parentNode!.removeChild(el)
      else if (moved.top !== a.row || moved.left !== a.col)
        el.setAttribute('ref', cellName({ row: moved.top, col: moved.left }))
      else continue
      changed = true
    }
    return changed
  })
  dropEmptyThreadedPart(wb, info)
}

/** Sorted rows: threads on the sorted cells move with their rows. */
export function sortThreads(wb: Workbook, info: SheetInfo, dest: Map<number, number>, left: number, right: number) {
  const part = threadedPartOf(wb, info)
  if (!part) return
  editIfChanged(wb, part, (doc) => {
    let changed = false
    for (const el of all(doc, 'threadedComment', NS_THREADED)) {
      const a = parseCell(el.getAttribute('ref') ?? '')
      const to = a && a.col >= left && a.col <= right ? dest.get(a.row) : undefined
      if (!a || to === undefined) continue
      el.setAttribute('ref', cellName({ row: to, col: a.col }))
      changed = true
    }
    return changed
  })
}
