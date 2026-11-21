import type { OpcPackage } from '../ooxml/package'
import { attr, children, descendants, isEl, NS, REL, wa } from './xml'

/**
 * Word comments (ECMA-376 Part 1 §17.13.4): the comments part (w:comments,
 * one w:comment per comment, its text as paragraphs) and the anchors in the
 * document (w:commentRangeStart / w:commentRangeEnd around the commented
 * text, w:commentReference where the comment mark sits). Threads and the
 * resolved state live in the Word 2012 extension part (w15:commentsEx: the
 * comment's last paragraph id, its parent's, and w15:done); Word 2016 adds
 * durable ids (w16cid:commentsIds). Runs in Node and the browser.
 */

export const NS_W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
export const NS_W15 = 'http://schemas.microsoft.com/office/word/2012/wordml'
export const NS_W16CID = 'http://schemas.microsoft.com/office/word/2016/wordml/cid'

export const REL_COMMENTS = REL.comments
export const REL_COMMENTS_EX = 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended'
export const REL_COMMENTS_IDS = 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds'

const ML = 'application/vnd.openxmlformats-officedocument.wordprocessingml'
export const CT_COMMENTS = `${ML}.comments+xml`
export const CT_COMMENTS_EX = `${ML}.commentsExtended+xml`
export const CT_COMMENTS_IDS = `${ML}.commentsIds+xml`

/** One comment as plain data (ProseMirror doc attrs hold a list of these while editing). */
export type CommentData = {
  /** w:id, as written. */
  id: string
  author: string
  initials: string
  /** ISO 8601, as written (w:date); null when the file has none. */
  date: string | null
  /** The comment's text: its paragraphs joined by "\n". */
  text: string
  /** The comment this one replies to (from w15:paraIdParent), or null. */
  parentId: string | null
  /** Resolved (w15:done). */
  done: boolean
  /** w14:paraId of the comment's last paragraph (what commentsEx and commentsIds key on), or null. */
  paraId: string | null
  /** w16cid:durableId, or null. */
  durableId: string | null
}

export type CommentParts = {
  comments: string | null
  extended: string | null
  ids: string | null
}

export type ParsedComments = {
  parts: CommentParts
  list: CommentData[]
  /** Comment id → its w:comment element (the source, never changed). */
  sources: Map<string, Element>
}

function partOf(pkg: OpcPackage, source: string, type: string): string | null {
  const rel = pkg.relationships(source).find((r) => r.type === type && !r.external)
  return rel?.part && pkg.has(rel.part) ? rel.part : null
}

/** The comment parts the document points at. */
export function commentParts(pkg: OpcPackage, mainPart: string): CommentParts {
  return { comments: partOf(pkg, mainPart, REL_COMMENTS), extended: partOf(pkg, mainPart, REL_COMMENTS_EX), ids: partOf(pkg, mainPart, REL_COMMENTS_IDS) }
}

/** The text of a paragraph container as Word shows it (w:t, tabs, breaks; deleted text left out). */
export function paragraphsText(container: Element): string {
  return descendants(container, NS.w, 'p').map(oneParagraph).join('\n')
}

function oneParagraph(p: Element): string {
  let s = ''
  const walk = (el: Element) => {
    for (const c of children(el)) {
      if (c.namespaceURI !== NS.w) continue
      const n = c.localName
      if (n === 'p' || n === 'del' || n === 'moveFrom' || n === 'pPr' || n === 'rPr') continue
      if (n === 't') s += c.textContent ?? ''
      else if (n === 'tab') s += '\t'
      else if (n === 'br' || n === 'cr') s += '\n'
      else walk(c)
    }
  }
  walk(p)
  return s
}

/** Up to three capitals from the words of a name ("Dana Ruiz" → "DR"). */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0]!.toUpperCase())
    .slice(0, 3)
    .join('')
}

/** The w14:paraId of an element's last paragraph. */
export function lastParaId(el: Element): string | null {
  const ps = descendants(el, NS.w, 'p')
  const last = ps.at(-1)
  return last ? attr(last, NS_W14, 'paraId') : null
}

export function parseComments(pkg: OpcPackage, mainPart: string): ParsedComments {
  const parts = commentParts(pkg, mainPart)
  const list: CommentData[] = []
  const sources = new Map<string, Element>()
  if (!parts.comments) return { parts, list, sources }
  const root = pkg.xml(parts.comments).documentElement!
  // Threads and resolved state, keyed by paragraph id (MS-DOCX 2.5.2.x, w15:commentEx).
  const ex = new Map<string, { parent: string | null; done: boolean }>()
  if (parts.extended) {
    for (const e of descendants(pkg.xml(parts.extended).documentElement!, NS_W15, 'commentEx')) {
      const pid = attr(e, NS_W15, 'paraId')
      if (pid) ex.set(pid.toUpperCase(), { parent: attr(e, NS_W15, 'paraIdParent'), done: onOffAttr(attr(e, NS_W15, 'done')) })
    }
  }
  const durable = new Map<string, string>()
  if (parts.ids) {
    for (const e of descendants(pkg.xml(parts.ids).documentElement!, NS_W16CID, 'commentId')) {
      const pid = attr(e, NS_W16CID, 'paraId')
      const d = attr(e, NS_W16CID, 'durableId')
      if (pid && d) durable.set(pid.toUpperCase(), d)
    }
  }
  const byPara = new Map<string, string>()
  const pending: { data: CommentData; parentPara: string | null }[] = []
  for (const c of children(root)) {
    if (!isEl(c, NS.w, 'comment')) continue
    const id = wa(c, 'id')
    if (id === null) continue
    const paraId = lastParaId(c)
    const info = paraId ? ex.get(paraId.toUpperCase()) : undefined
    const author = wa(c, 'author') ?? ''
    const data: CommentData = {
      id,
      author,
      initials: wa(c, 'initials') ?? initialsOf(author),
      date: wa(c, 'date'),
      text: paragraphsText(c),
      parentId: null,
      done: info?.done ?? false,
      paraId,
      durableId: paraId ? (durable.get(paraId.toUpperCase()) ?? null) : null,
    }
    if (paraId) byPara.set(paraId.toUpperCase(), id)
    sources.set(id, c)
    pending.push({ data, parentPara: info?.parent ?? null })
  }
  for (const { data, parentPara } of pending) {
    data.parentId = parentPara ? (byPara.get(parentPara.toUpperCase()) ?? null) : null
    list.push(data)
  }
  return { parts, list, sources }
}

const onOffAttr = (v: string | null) => v !== null && !(v === '0' || v === 'false' || v === 'off')

/**
 * Which comments each piece of text lies inside: w:t / w:delText elements of
 * a story → the ids of the comment ranges open around them, in document order.
 */
export function commentAnchors(root: Element): Map<Element, string[]> {
  const out = new Map<Element, string[]>()
  const open: string[] = []
  const walk = (el: Element) => {
    for (const c of children(el)) {
      if (c.namespaceURI === NS.w) {
        const n = c.localName
        if (n === 'commentRangeStart') {
          const id = wa(c, 'id')
          if (id !== null && !open.includes(id)) open.push(id)
          continue
        }
        if (n === 'commentRangeEnd') {
          const id = wa(c, 'id')
          const i = id === null ? -1 : open.indexOf(id)
          if (i >= 0) open.splice(i, 1)
          continue
        }
        if ((n === 't' || n === 'delText') && open.length > 0) {
          out.set(c, [...open])
          continue
        }
      }
      walk(c)
    }
  }
  walk(root)
  return out
}

/** The ids of the comments a story references (w:commentReference). */
export function referencedComments(root: Element): Set<string> {
  return new Set(descendants(root, NS.w, 'commentReference').map((e) => wa(e, 'id') ?? ''))
}

/** The ISO 8601 date Word writes (seconds, UTC, no fraction). */
export const wordDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
