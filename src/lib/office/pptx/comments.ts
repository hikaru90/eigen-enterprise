import type { OpcPackage } from '../ooxml/package'
import { attr, children, intAttr, isEl, NS } from './xml'

/**
 * PowerPoint comments (plan/phase-office-files.md, S3), read from the file's
 * own parts so they travel with it.
 *
 * Two formats:
 * - **Modern threaded comments** (the PowerPoint 2018 extension, namespace
 *   p188): one presentation-level author list (`authors.xml`, linked from
 *   presentation.xml) and one comment part per slide (linked from the slide),
 *   each comment with its text, author, created time, status (active /
 *   resolved), replies, an optional position, and a moniker list that anchors
 *   it to the slide, a shape on it, or a range of a shape's text.
 * - **Legacy comments** (ECMA-376 Part 1 §19.4): `commentAuthors.xml` and a
 *   per-slide `p:cmLst`, positioned in 1/576 inch. Read-only here; PowerPoint
 *   2013 threads them with a `p15:threadingInfo` extension, read as replies.
 *
 * When a slide has a modern comment part, that part wins and the slide's
 * legacy comments are not shown as threads; the slide says how many it left
 * out (`legacyIgnored`), never silently.
 */

export const NS_P188 = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main'
export const NS_P15 = 'http://schemas.microsoft.com/office/powerpoint/2012/main'
export const NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
/** Document monikers (slide markers) and drawing-element monikers (shape and text markers). */
export const NS_PC = 'http://schemas.microsoft.com/office/powerpoint/2013/main/command'
export const NS_AC = 'http://schemas.microsoft.com/office/drawing/2013/main/command'
export const NS_A16 = 'http://schemas.microsoft.com/office/drawing/2014/main'

export const REL_MODERN_COMMENTS = 'http://schemas.microsoft.com/office/2018/10/relationships/comments'
export const REL_MODERN_AUTHORS = 'http://schemas.microsoft.com/office/2018/10/relationships/authors'
export const REL_LEGACY_COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
export const REL_LEGACY_AUTHORS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors'
export const CT_MODERN_COMMENTS = 'application/vnd.ms-powerpoint.comments+xml'
export const CT_MODERN_AUTHORS = 'application/vnd.ms-powerpoint.authors+xml'
/** The slide extension that names the slide's modern comment relationship. */
export const EXT_COMMENT_REL = '{6950BFC3-D8DA-4A85-94F7-54DA5524770B}'
/** Who wrote a comment in this app: authors are matched by this provider and the member id, never by name. */
export const PROVIDER = 'eigenEnterprise'

/** EMU per legacy comment position unit (1/576 inch). */
const LEGACY_UNIT = 914400 / 576

export type CommentPerson = {
  /** The author id in the file (a GUID for modern comments, a number for legacy ones). */
  id: string
  name: string
  initials: string
  /** Who the author is in their identity provider (modern authors only). */
  userId: string | null
  providerId: string | null
}

export type CommentAnchor =
  | { kind: 'slide' }
  | { kind: 'shape'; shape: string }
  /** A range of a shape's text: start character and length. */
  | { kind: 'text'; shape: string; start: number; length: number }

export type CommentStatus = 'active' | 'resolved' | 'closed'

export type CommentReply = {
  id: string
  author: CommentPerson | null
  authorId: string
  created: string | null
  text: string
}

export type SlideComment = {
  id: string
  format: 'modern' | 'legacy'
  author: CommentPerson | null
  authorId: string
  created: string | null
  status: CommentStatus
  text: string
  anchor: CommentAnchor
  /** Where its marker sits, in EMU; null: not placed (the anchor decides). */
  pos: { x: number; y: number } | null
  replies: CommentReply[]
}

export type SlideComments = {
  threads: SlideComment[]
  /** Legacy comments on the slide not shown because its modern comments win. */
  legacyIgnored: number
  /** A comment part that could not be read: the reason (the slide still opens). */
  error: string | null
}

export type CommentAuthors = { modern: Record<string, CommentPerson>; legacy: Record<string, CommentPerson> }

const relTo = (pkg: OpcPackage, source: string, type: string) => pkg.relationships(source).find((r) => r.type === type && !r.external && r.part && pkg.has(r.part))?.part ?? null

/** The deck's author lists (empty when it has none). */
export function readAuthors(pkg: OpcPackage, presPart: string): CommentAuthors {
  const out: CommentAuthors = { modern: {}, legacy: {} }
  const modern = relTo(pkg, presPart, REL_MODERN_AUTHORS)
  if (modern) {
    for (const el of children(pkg.xml(modern).documentElement as unknown as Element, NS_P188, 'author')) {
      const id = attr(el, 'id') ?? ''
      out.modern[id] = { id, name: attr(el, 'name') ?? '', initials: attr(el, 'initials') ?? '', userId: attr(el, 'userId'), providerId: attr(el, 'providerId') }
    }
  }
  const legacy = relTo(pkg, presPart, REL_LEGACY_AUTHORS)
  if (legacy) {
    for (const el of children(pkg.xml(legacy).documentElement as unknown as Element, NS.p, 'cmAuthor')) {
      const id = attr(el, 'id') ?? ''
      out.legacy[id] = { id, name: attr(el, 'name') ?? '', initials: attr(el, 'initials') ?? '', userId: null, providerId: null }
    }
  }
  return out
}

/** The plain text of a DrawingML text body: paragraphs on their own lines, line breaks as "\n". */
export function bodyText(body: Element | null): string {
  if (!body) return ''
  return children(body, NS.a, 'p')
    .map((p) => {
      let s = ''
      for (let n = p.firstChild; n; n = n.nextSibling) {
        if (!isEl(n) || n.namespaceURI !== NS.a) continue
        if (n.localName === 'br') s += '\n'
        else if (n.localName === 'r' || n.localName === 'fld') s += children(n, NS.a, 't').map((t) => t.textContent ?? '').join('')
      }
      return s
    })
    .join('\n')
}

const statusOf = (v: string | null): CommentStatus => (v === 'resolved' ? 'resolved' : v === 'closed' ? 'closed' : 'active')

function elementKids(el: Element): Element[] {
  const out: Element[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) if (isEl(n)) out.push(n)
  return out
}

/** The anchor a modern comment's moniker list names (slide, a drawing element, or a text range of one). */
function anchorOf(cm: Element): CommentAnchor {
  for (const list of elementKids(cm)) {
    if (list.namespaceURI === NS_PC && list.localName === 'sldMkLst') return { kind: 'slide' }
    if (list.namespaceURI !== NS_AC) continue
    // The drawing-element moniker is the ac:* child with an id (spMk, picMk, grpSpMk, cxnSpMk, graphicFrameMk …).
    const element = elementKids(list).filter((k) => k.namespaceURI === NS_AC && k.localName !== 'txMk' && k.hasAttribute('id'))
    const shape = element.at(-1)?.getAttribute('id') ?? null
    if (!shape) return { kind: 'slide' }
    if (list.localName === 'txMkLst') {
      const tx = elementKids(list).find((k) => k.namespaceURI === NS_AC && k.localName === 'txMk')
      if (tx) return { kind: 'text', shape, start: intAttr(tx, 'cp') ?? 0, length: intAttr(tx, 'len') ?? 0 }
    }
    return { kind: 'shape', shape }
  }
  return { kind: 'slide' }
}

const child = (el: Element, ns: string, name: string) => elementKids(el).find((k) => k.namespaceURI === ns && k.localName === name) ?? null

function readModern(pkg: OpcPackage, part: string, authors: CommentAuthors): SlideComment[] {
  const root = pkg.xml(part).documentElement as unknown as Element
  if (root.namespaceURI !== NS_P188 || root.localName !== 'cmLst') throw new Error(`${part} is not a comment list.`)
  return children(root, NS_P188, 'cm').map((cm) => {
    const authorId = attr(cm, 'authorId') ?? ''
    const pos = child(cm, NS_P188, 'pos')
    return {
      id: attr(cm, 'id') ?? '',
      format: 'modern' as const,
      authorId,
      author: authors.modern[authorId] ?? null,
      created: attr(cm, 'created'),
      status: statusOf(attr(cm, 'status')),
      text: bodyText(child(cm, NS_P188, 'txBody')),
      anchor: anchorOf(cm),
      pos: pos ? { x: intAttr(pos, 'x') ?? 0, y: intAttr(pos, 'y') ?? 0 } : null,
      replies: children(child(cm, NS_P188, 'replyLst'), NS_P188, 'reply').map((r) => {
        const rid = attr(r, 'authorId') ?? ''
        return { id: attr(r, 'id') ?? '', authorId: rid, author: authors.modern[rid] ?? null, created: attr(r, 'created'), text: bodyText(child(r, NS_P188, 'txBody')) }
      }),
    }
  })
}

const legacyId = (authorId: string, idx: string) => `legacy:${authorId}:${idx}`

function readLegacy(pkg: OpcPackage, part: string, authors: CommentAuthors): SlideComment[] {
  const root = pkg.xml(part).documentElement as unknown as Element
  if (root.namespaceURI !== NS.p || root.localName !== 'cmLst') throw new Error(`${part} is not a comment list.`)
  const threads: SlideComment[] = []
  const byId = new Map<string, SlideComment>()
  const replies: Array<{ parent: string; reply: CommentReply }> = []
  for (const cm of children(root, NS.p, 'cm')) {
    const authorId = attr(cm, 'authorId') ?? ''
    const id = legacyId(authorId, attr(cm, 'idx') ?? '')
    const text = child(cm, NS.p, 'text')?.textContent ?? ''
    const created = attr(cm, 'dt')
    const parent = cm.getElementsByTagNameNS(NS_P15, 'parentCm')[0]
    if (parent) {
      replies.push({ parent: legacyId(attr(parent, 'authorId') ?? '', attr(parent, 'idx') ?? ''), reply: { id, authorId, author: authors.legacy[authorId] ?? null, created, text } })
      continue
    }
    const pos = child(cm, NS.p, 'pos')
    const c: SlideComment = {
      id,
      format: 'legacy',
      authorId,
      author: authors.legacy[authorId] ?? null,
      created,
      status: 'active',
      text,
      anchor: { kind: 'slide' },
      pos: pos ? { x: Math.round((intAttr(pos, 'x') ?? 0) * LEGACY_UNIT), y: Math.round((intAttr(pos, 'y') ?? 0) * LEGACY_UNIT) } : null,
      replies: [],
    }
    threads.push(c)
    byId.set(id, c)
  }
  for (const { parent, reply } of replies) {
    const thread = byId.get(parent)
    // A reply whose parent is gone is still a comment: shown on its own.
    if (thread) thread.replies.push(reply)
    else threads.push({ ...reply, format: 'legacy', status: 'active', anchor: { kind: 'slide' }, pos: null, replies: [] })
  }
  return threads
}

/** A slide's comments: its modern part when it has one, else its legacy part. */
export function readSlideComments(pkg: OpcPackage, slidePart: string, authors: CommentAuthors): SlideComments {
  const modern = relTo(pkg, slidePart, REL_MODERN_COMMENTS)
  const legacy = relTo(pkg, slidePart, REL_LEGACY_COMMENTS)
  const out: SlideComments = { threads: [], legacyIgnored: 0, error: null }
  try {
    if (modern) {
      out.threads = readModern(pkg, modern, authors)
      if (legacy) out.legacyIgnored = readLegacy(pkg, legacy, authors).reduce((n, t) => n + 1 + t.replies.length, 0)
    } else if (legacy) out.threads = readLegacy(pkg, legacy, authors)
  } catch (err) {
    out.threads = []
    out.error = `The comments on this slide could not be read: ${err instanceof Error ? err.message : String(err)}`
  }
  return out
}

/** The modern comment part of a slide, or null. */
export const modernCommentPart = (pkg: OpcPackage, slidePart: string) => relTo(pkg, slidePart, REL_MODERN_COMMENTS)
export const modernAuthorsPart = (pkg: OpcPackage, presPart: string) => relTo(pkg, presPart, REL_MODERN_AUTHORS)
export const legacyCommentPart = (pkg: OpcPackage, slidePart: string) => relTo(pkg, slidePart, REL_LEGACY_COMMENTS)

/** Is this the signed-in member (matched by provider and member id)? */
export const isMember = (person: CommentPerson | null, memberId: string) => !!person && person.providerId === PROVIDER && person.userId === memberId
