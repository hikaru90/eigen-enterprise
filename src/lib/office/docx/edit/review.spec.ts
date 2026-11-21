import type { Node as PMNode } from 'prosemirror-model'
import { strFromU8, unzipSync } from 'fflate'
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { parseDocx, paragraphText, type Paragraph } from '../model'
import { buildDocx, p, r, sectPr } from '../test-utils/builder'
import { extractText } from '../text'
import {
  addComment,
  decideAll,
  decideChange,
  deleteComment,
  editComment,
  gotoChange,
  replyToComment,
  setCommentDone,
  setTracking,
  trackedChanges,
  trackTransaction,
  type Reviewer,
} from './review'
import { openForEditing, type DocxEditSession } from './session'

const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml'
const W16CID = 'http://schemas.microsoft.com/office/word/2016/wordml/cid'
const ML = 'application/vnd.openxmlformats-officedocument.wordprocessingml'

const DANA: Reviewer = { name: 'Dana Ruiz', initials: 'DR' }

/** A document with comments (a thread, one resolved), tracked changes of every kind, and rsids everywhere. */
function reviewedDocx() {
  const body =
    p(
      `<w:commentRangeStart w:id="0"/><w:r w:rsidR="00AA"><w:t xml:space="preserve">Revenue grew </w:t></w:r>` +
        `<w:ins w:id="10" w:author="Ann" w:date="2026-11-01T09:00:00Z" w16du:dateUtc="2026-11-01T09:00:00Z" xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du"><w:r w:rsidR="00BB"><w:t>sharply</w:t></w:r></w:ins>` +
        `<w:del w:id="11" w:author="Bo" w:date="2026-11-02T09:00:00Z"><w:r w:rsidDel="00CC"><w:delText xml:space="preserve"> slowly</w:delText></w:r></w:del>` +
        `<w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>` +
        `<w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>`,
    ) +
    p(
      `<w:r><w:rPr><w:b/><w:rPrChange w:id="12" w:author="Ann" w:date="2026-11-03T09:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>Bold now.</w:t></w:r>`,
    ) +
    `<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="13" w:author="Bo" w:date="2026-11-04T09:00:00Z"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>${r('Centred now.')}</w:p>` +
    p(r('Plain text here.')) +
    sectPr()
  return buildDocx({
    body,
    settings: '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>',
    comments:
      `<w:comment w:id="0" w:author="Ann" w:initials="A" w:date="2026-11-01T10:00:00Z"><w:p w14:paraId="0000000A" w14:textId="77777777" ${W14}>${r('Source?')}</w:p></w:comment>` +
      `<w:comment w:id="1" w:author="Dana Ruiz" w:initials="DR" w:date="2026-11-01T11:00:00Z"><w:p w14:paraId="0000000B" w14:textId="77777777" ${W14}>${r('Q3 report')}</w:p></w:comment>`,
    parts: {
      rIdEx: {
        type: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
        target: 'commentsExtended.xml',
        contentType: `${ML}.commentsExtended+xml`,
        xml: `<w15:commentsEx xmlns:w15="${W15}"><w15:commentEx w15:paraId="0000000A" w15:done="0"/><w15:commentEx w15:paraId="0000000B" w15:paraIdParent="0000000A" w15:done="0"/></w15:commentsEx>`,
      },
      rIdIds: {
        type: 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds',
        target: 'commentsIds.xml',
        contentType: `${ML}.commentsIds+xml`,
        xml: `<w16cid:commentsIds xmlns:w16cid="${W16CID}"><w16cid:commentId w16cid:paraId="0000000A" w16cid:durableId="1A2B3C4D"/><w16cid:commentId w16cid:paraId="0000000B" w16cid:durableId="1A2B3C4E"/></w16cid:commentsIds>`,
      },
    },
  })
}

const plainDocx = () =>
  buildDocx({ body: p(r('Hello world')) + p(r('Second paragraph')) + sectPr() })

const parts = (bytes: Uint8Array) => unzipSync(bytes)
const xmlOf = (bytes: Uint8Array, name: string) => strFromU8(parts(bytes)[name]!)
const changedParts = (a: Uint8Array, b: Uint8Array) => {
  const pa = parts(a)
  const pb = parts(b)
  return [...new Set([...Object.keys(pa), ...Object.keys(pb)])]
    .filter((n) => !pa[n] || !pb[n] || strFromU8(pa[n]!) !== strFromU8(pb[n]!))
    .sort()
}

/** The range of the first occurrence of `text`. */
function find(doc: PMNode, text: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  doc.descendants((n, pos) => {
    if (found) return false
    if (n.isText && n.text!.includes(text)) {
      const from = pos + n.text!.indexOf(text)
      found = { from, to: from + text.length }
    }
    return true
  })
  if (!found) throw new Error(`"${text}" not in the document`)
  return found
}

function editor(session: DocxEditSession) {
  let state = EditorState.create({ doc: session.initial })
  const ids = { newId: () => session.newId(), now: () => '2026-11-21T12:00:00Z' }
  return {
    get state() {
      return state
    },
    run(cmd: Command) {
      const ok = cmd(state, (tr) => (state = state.apply(tr)))
      if (!ok) throw new Error('command did not apply')
    },
    /** A user edit, tracked when the document says so. */
    edit(make: (s: EditorState) => Transaction) {
      const tr = make(state)
      state = state.apply(
        state.doc.attrs.trackRevisions ? trackTransaction(state, tr, DANA, ids) : tr,
      )
    },
    select(from: number, to = from) {
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
    },
  }
}

const bodyText = (bytes: Uint8Array) =>
  parseDocx(bytes)
    .sections[0]!.blocks.filter((b): b is Paragraph => b.type === 'paragraph')
    .map(paragraphText)

describe('docx review: lossless round trip', () => {
  it('saves a file with comments and tracked changes, unedited, with every part byte-identical', () => {
    const src = reviewedDocx()
    const session = openForEditing(src)
    const out = session.serialize(session.initial)
    expect(changedParts(src, out)).toEqual([])
    for (const [name, bytes] of Object.entries(parts(src)))
      expect(parts(out)[name], name).toEqual(bytes)
  })

  it('reads the changes and comments into the editor', () => {
    const session = openForEditing(reviewedDocx())
    const changes = trackedChanges(session.initial)
    expect(changes.map((c) => [c.kind, c.author])).toEqual([
      ['insert', 'Ann'],
      ['delete', 'Bo'],
      ['format', 'Ann'],
      ['paragraph', 'Bo'],
    ])
    expect(session.initial.attrs.comments).toMatchObject([
      { id: '0', author: 'Ann', text: 'Source?', parentId: null, durableId: '1A2B3C4D' },
      { id: '1', author: 'Dana Ruiz', text: 'Q3 report', parentId: '0' },
    ])
    expect(session.initial.attrs.trackRevisions).toBe(false)
  })

  it('an edit elsewhere keeps the revision elements exactly as written (rsids, w16du dates)', () => {
    const src = reviewedDocx()
    const session = openForEditing(src)
    const e = editor(session)
    e.edit((s) => s.tr.insertText('!', find(s.doc, 'Plain text here.').to))
    const xml = xmlOf(session.serialize(e.state.doc), 'word/document.xml')
    expect(xml).toContain('w16du:dateUtc="2026-11-01T09:00:00Z"')
    expect(xml).toContain(
      '<w:del w:id="11" w:author="Bo" w:date="2026-11-02T09:00:00Z"><w:r w:rsidDel="00CC"><w:delText xml:space="preserve"> slowly</w:delText></w:r></w:del>',
    )
    expect(xml).toContain(
      '<w:rPrChange w:id="12" w:author="Ann" w:date="2026-11-03T09:00:00Z"><w:rPr/></w:rPrChange>',
    )
    expect(xml).toContain(
      '<w:pPrChange w:id="13" w:author="Bo" w:date="2026-11-04T09:00:00Z"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange>',
    )
    expect(changedParts(src, session.serialize(e.state.doc))).toEqual(['word/document.xml'])
  })
})

describe('docx review: comments', () => {
  it('adds a comment on the selection: anchors in the text, new parts with relationships and content types', () => {
    const src = plainDocx()
    const session = openForEditing(src)
    const e = editor(session)
    const range = find(e.state.doc, 'world')
    e.select(range.from, range.to)
    e.run(addComment(session, DANA, 'Which world?'))
    const out = session.serialize(e.state.doc)
    expect(changedParts(src, out)).toEqual([
      '[Content_Types].xml',
      'word/_rels/document.xml.rels',
      'word/comments.xml',
      'word/commentsExtended.xml',
      'word/commentsIds.xml',
      'word/document.xml',
    ])
    const doc = xmlOf(out, 'word/document.xml')
    const id = (e.state.doc.attrs.comments as { id: string }[])[0]!.id
    expect(doc).toContain(
      `<w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:commentRangeStart w:id="${id}"/><w:r><w:t>world</w:t></w:r><w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`,
    )
    const ct = xmlOf(out, '[Content_Types].xml')
    expect(ct).toContain(
      `<Override PartName="/word/comments.xml" ContentType="${ML}.comments+xml"/>`,
    )
    expect(ct).toContain(
      `<Override PartName="/word/commentsExtended.xml" ContentType="${ML}.commentsExtended+xml"/>`,
    )
    const rels = xmlOf(out, 'word/_rels/document.xml.rels')
    expect(rels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"',
    )
    expect(rels).toContain(
      'Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"',
    )
    expect(rels).toContain(
      'Type="http://schemas.microsoft.com/office/2016/09/relationships/commentsIds" Target="commentsIds.xml"',
    )
    // Re-parsed: present, with author, initials and an ISO date.
    const again = parseDocx(out)
    expect(again.comments).toHaveLength(1)
    expect(again.comments[0]).toMatchObject({
      id,
      author: 'Dana Ruiz',
      initials: 'DR',
      text: 'Which world?',
      parentId: null,
      done: false,
    })
    expect(again.comments[0]!.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(again.comments[0]!.paraId).toMatch(/^[0-9A-F]{8}$/)
    const anchored = [...again.commentAnchors.values()]
    expect(anchored).toEqual([[id]])
  })

  it('adds to an existing comments part: untouched comments keep their XML, ids stay unique, only comment parts and the body change', () => {
    const src = reviewedDocx()
    const session = openForEditing(src)
    const e = editor(session)
    const range = find(e.state.doc, 'Plain')
    e.select(range.from, range.to)
    e.run(addComment(session, DANA, 'Too plain'))
    const out = session.serialize(e.state.doc)
    expect(changedParts(src, out)).toEqual([
      'word/comments.xml',
      'word/commentsExtended.xml',
      'word/commentsIds.xml',
      'word/document.xml',
    ])
    const before = xmlOf(src, 'word/comments.xml')
    const after = xmlOf(out, 'word/comments.xml')
    for (const el of before.match(/<w:comment [\s\S]*?<\/w:comment>/g)!) expect(after).toContain(el)
    const ids = parseDocx(out).comments.map((c) => c.id)
    expect(new Set(ids).size).toBe(3)
    expect(Number(ids[2])).toBeGreaterThan(13)
  })

  it('replies in a thread, resolves and reopens, edits your own, and deletes with the replies', () => {
    const session = openForEditing(reviewedDocx())
    const e = editor(session)
    e.run(replyToComment(session, DANA, '0', 'Found it'))
    e.run(setCommentDone(session, '0', true))
    e.run(editComment(DANA, '1', 'Q3 report, page 4'))
    // Not your own: no edit.
    expect(editComment(DANA, '0', 'changed')(e.state)).toBe(false)
    let out = session.serialize(e.state.doc)
    let parsed = parseDocx(out).comments
    expect(parsed.map((c) => [c.author, c.text, c.parentId, c.done])).toEqual([
      ['Ann', 'Source?', null, true],
      ['Dana Ruiz', 'Q3 report, page 4', '0', false],
      ['Dana Ruiz', 'Found it', '0', false],
    ])
    const ex = xmlOf(out, 'word/commentsExtended.xml')
    expect(ex).toContain('<w15:commentEx w15:paraId="0000000A" w15:done="1"/>')
    // The reply is anchored next to its comment.
    const replyId = parsed[2]!.id
    expect(xmlOf(out, 'word/document.xml')).toContain(
      `<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="${replyId}"/>`,
    )
    e.run(setCommentDone(session, '0', false))
    expect(parseDocx(session.serialize(e.state.doc)).comments[0]!.done).toBe(false)
    e.run(deleteComment('0'))
    out = session.serialize(e.state.doc)
    parsed = parseDocx(out).comments
    expect(parsed).toEqual([])
    const doc = xmlOf(out, 'word/document.xml')
    expect(doc).not.toContain('commentRangeStart')
    expect(doc).not.toContain('commentReference')
    expect(xmlOf(out, 'word/commentsExtended.xml')).not.toContain('0000000A')
    expect(xmlOf(out, 'word/commentsIds.xml')).not.toContain('0000000A')
  })

  it('drops a comment whose text was deleted (as Word does), and goes back to the original bytes on undoing everything', () => {
    const src = reviewedDocx()
    const session = openForEditing(src)
    const e = editor(session)
    const { from } = find(e.state.doc, 'Revenue')
    const end = find(e.state.doc, 'sharply').to
    e.edit((s) => s.tr.delete(from - 1, end + 9))
    expect(session.liveComments(e.state.doc).map((c) => c.id)).toEqual(['1'])
    // Back to the document as opened: every part as it was.
    expect(changedParts(src, session.serialize(session.initial))).toEqual([])
  })
})

describe('docx review: tracked changes', () => {
  it('turning Track changes on writes w:trackRevisions in its place in settings.xml; off removes it', () => {
    const src = reviewedDocx()
    const session = openForEditing(src)
    const e = editor(session)
    e.run(setTracking(true))
    let out = session.serialize(e.state.doc)
    expect(changedParts(src, out)).toEqual(['word/settings.xml'])
    expect(xmlOf(out, 'word/settings.xml')).toContain(
      '<w:zoom w:percent="100"/><w:trackRevisions/><w:defaultTabStop w:val="720"/>',
    )
    expect(parseDocx(out).settings.trackRevisions).toBe(true)
    e.run(setTracking(false))
    out = session.serialize(e.state.doc)
    expect(changedParts(src, out)).toEqual([])
  })

  it('creates settings.xml for a file without one', () => {
    const src = plainDocx()
    const session = openForEditing(src)
    const e = editor(session)
    e.run(setTracking(true))
    const out = session.serialize(e.state.doc)
    expect(changedParts(src, out)).toEqual([
      '[Content_Types].xml',
      'word/_rels/document.xml.rels',
      'word/settings.xml',
    ])
    expect(parseDocx(out).settings.trackRevisions).toBe(true)
  })

  it('while tracking, typing makes a w:ins and deleting a w:del with author and date', () => {
    const session = openForEditing(plainDocx())
    const e = editor(session)
    e.run(setTracking(true))
    const world = find(e.state.doc, 'world')
    e.select(world.to)
    e.edit((s) => s.tr.insertText(' and you', world.to))
    e.edit((s) => s.tr.insertText('!', world.to + ' and you'.length))
    const hello = find(e.state.doc, 'Hello')
    e.select(hello.to)
    e.edit((s) => s.tr.delete(hello.from, hello.to))
    const xml = xmlOf(session.serialize(e.state.doc), 'word/document.xml')
    const ins =
      /<w:ins w:id="(\d+)" w:author="Dana Ruiz" w:date="2026-11-21T12:00:00Z"><w:r><w:t xml:space="preserve"> and you!<\/w:t><\/w:r><\/w:ins>/.exec(
        xml,
      )
    expect(ins, xml).not.toBeNull()
    const del =
      /<w:del w:id="(\d+)" w:author="Dana Ruiz" w:date="2026-11-21T12:00:00Z"><w:r><w:delText>Hello<\/w:delText><\/w:r><\/w:del>/.exec(
        xml,
      )
    expect(del, xml).not.toBeNull()
    expect(ins![1]).not.toBe(del![1])
    // Deleted text stays, struck; the cursor moved before it (a backspace).
    expect(e.state.selection.from).toBe(hello.from)
  })

  it('deleting your own pending insertion removes it outright; another reviewer’s gets struck', () => {
    const session = openForEditing(reviewedDocx())
    const e = editor(session)
    e.run(setTracking(true))
    const at = find(e.state.doc, 'Plain').from
    e.edit((s) => s.tr.insertText('New ', at))
    e.edit((s) => s.tr.delete(at, at + 4))
    expect(find(e.state.doc, 'Plain').from).toBe(at)
    const sharply = find(e.state.doc, 'sharply')
    e.edit((s) => s.tr.delete(sharply.from, sharply.to))
    const xml = xmlOf(session.serialize(e.state.doc), 'word/document.xml')
    expect(xml).toMatch(
      /<w:ins w:id="10"[^>]*><w:del w:id="\d+" w:author="Dana Ruiz" w:date="2026-11-21T12:00:00Z"><w:r w:rsidR="00BB"><w:delText>sharply<\/w:delText><\/w:r><\/w:del><\/w:ins>/,
    )
  })

  it('while tracking, formatting records w:rPrChange with the formatting before', () => {
    const session = openForEditing(plainDocx())
    const e = editor(session)
    e.run(setTracking(true))
    const hello = find(e.state.doc, 'Hello')
    e.edit((s) => s.tr.addMark(hello.from, hello.to, s.schema.marks.bold!.create()))
    const xml = xmlOf(session.serialize(e.state.doc), 'word/document.xml')
    expect(xml).toMatch(
      /<w:r><w:rPr><w:b\/><w:bCs\/><w:rPrChange w:id="\d+" w:author="Dana Ruiz" w:date="2026-11-21T12:00:00Z"><w:rPr\/><\/w:rPrChange><\/w:rPr><w:t>Hello<\/w:t><\/w:r>/,
    )
    // Rejecting it puts the formatting back.
    const [change] = trackedChanges(e.state.doc)
    e.run(decideChange(session, change!, false))
    expect(xmlOf(session.serialize(e.state.doc), 'word/document.xml')).toContain(
      '<w:r><w:t xml:space="preserve">Hello world</w:t></w:r>',
    )
  })

  it('accepting all keeps insertions and drops deletions; rejecting all does the opposite', async () => {
    const accepted = openForEditing(reviewedDocx())
    const a = editor(accepted)
    a.run(decideAll(accepted, true))
    expect(trackedChanges(a.state.doc)).toEqual([])
    const outA = accepted.serialize(a.state.doc)
    expect(bodyText(outA)).toEqual([
      'Revenue grew sharply',
      'Bold now.',
      'Centred now.',
      'Plain text here.',
    ])
    const xmlA = xmlOf(outA, 'word/document.xml')
    expect(xmlA).not.toMatch(/w:ins |w:del |rPrChange|pPrChange/)
    expect(xmlA).toContain('<w:rPr><w:b/></w:rPr><w:t>Bold now.</w:t>')
    expect(xmlA).toContain('<w:jc w:val="center"/>')
    expect(await extractText(outA)).not.toContain('{+')

    const rejected = openForEditing(reviewedDocx())
    const b = editor(rejected)
    b.run(decideAll(rejected, false))
    const outB = rejected.serialize(b.state.doc)
    expect(bodyText(outB)).toEqual([
      'Revenue grew  slowly',
      'Bold now.',
      'Centred now.',
      'Plain text here.',
    ])
    const xmlB = xmlOf(outB, 'word/document.xml')
    expect(xmlB).not.toMatch(/w:ins |w:del |rPrChange|pPrChange|delText/)
    expect(xmlB).toContain('<w:r><w:t>Bold now.</w:t></w:r>')
    expect(xmlB).toContain('<w:jc w:val="left"/>')
    expect(xmlB).not.toContain('<w:jc w:val="center"/>')
  })

  it('accepts or rejects one change, and steps through them', () => {
    const session = openForEditing(reviewedDocx())
    const e = editor(session)
    e.select(1)
    e.run(gotoChange(1))
    const first = trackedChanges(e.state.doc)[0]!
    expect([e.state.selection.from, e.state.selection.to]).toEqual([first.from, first.to])
    e.run(gotoChange(1))
    expect(e.state.selection.from).toBe(trackedChanges(e.state.doc)[1]!.from)
    e.run(gotoChange(-1))
    expect(e.state.selection.from).toBe(first.from)
    e.run(decideChange(session, first, false))
    e.run(decideChange(session, trackedChanges(e.state.doc)[0]!, false))
    expect(bodyText(session.serialize(e.state.doc))[0]).toBe('Revenue grew  slowly')
    expect(trackedChanges(e.state.doc).map((c) => c.kind)).toEqual(['format', 'paragraph'])
  })
})
