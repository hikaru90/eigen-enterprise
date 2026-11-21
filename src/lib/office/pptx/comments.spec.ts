import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readPackage } from '../ooxml/package'
import { createDeckEditor } from './editor'
import { openDeck, type Deck } from './model'
import { buildPptx, para, ph, sp } from './test-utils/build-pptx'
import { BOB, CAROL, commentedDeck, commentedPptx, P188, REL_MODERN_AUTHORS, REL_MODERN_COMMENTS } from './test-utils/comment-fixtures'

const S1 = '/ppt/slides/slide1.xml'
const S2 = '/ppt/slides/slide2.xml'
const S3 = '/ppt/slides/slide3.xml'
const MC1 = 'ppt/comments/modernComment_100_1.xml'

const entries = (bytes: Uint8Array) => unzipSync(bytes)
const same = (x: Uint8Array | undefined, y: Uint8Array | undefined) => !!x && !!y && Buffer.from(x).equals(Buffer.from(y))
const xmlOf = (bytes: Uint8Array, name: string) => strFromU8(entries(bytes)[name]!)
const reread = (bytes: Uint8Array): Deck => openDeck(bytes).deck

/** The ZIP entries that differ between two packages (added, removed or changed). */
function changedEntries(before: Uint8Array, after: Uint8Array): string[] {
  const b = entries(before)
  const a = entries(after)
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((n) => !same(b[n], a[n])).sort()
}

function expectSame(before: Uint8Array, after: Uint8Array) {
  expect(changedEntries(before, after)).toEqual([])
}

const open = (bytes: Uint8Array) => createDeckEditor(readPackage(bytes))

describe('reading comments', () => {
  it('reads modern threaded comments: text, author, created, status, replies, anchors, position', () => {
    const d = reread(commentedPptx())
    const [c1, c2, c3] = d.slides[0]!.comments.threads
    expect(c1).toMatchObject({
      id: '{C1}',
      format: 'modern',
      text: 'Check the numbers\nbefore Friday',
      created: '2026-11-01T09:00:00.000',
      status: 'active',
      anchor: { kind: 'slide' },
      pos: { x: 914400, y: 457200 },
      author: { name: 'Alice Smith', initials: 'AS', userId: 'alice@example.com', providerId: 'AD' },
    })
    expect(c1!.replies.map((r) => [r.author?.name, r.text])).toEqual([
      ['Bob Brown', 'On it.'],
      ['Alice Smith', 'Thanks'],
    ])
    expect(c2).toMatchObject({ id: '{C2}', status: 'resolved', anchor: { kind: 'shape', shape: '3' }, pos: null, text: 'Bigger box' })
    expect(c3).toMatchObject({ anchor: { kind: 'text', shape: '3', start: 2, length: 4 }, text: 'Typo' })
  })

  it('modern comments win over legacy ones on the same slide, and the slide says how many it left out', () => {
    const d = reread(commentedPptx())
    expect(d.slides[0]!.comments.threads.every((t) => t.format === 'modern')).toBe(true)
    expect(d.slides[0]!.comments.legacyIgnored).toBe(2)
  })

  it('reads legacy comments (commentAuthors + p:cmLst), threaded replies included, positions in EMU', () => {
    const d = reread(commentedPptx())
    const s2 = d.slides[1]!.comments
    expect(s2.legacyIgnored).toBe(0)
    expect(s2.threads).toHaveLength(1)
    expect(s2.threads[0]).toMatchObject({ format: 'legacy', text: 'Old remark', author: { name: 'Dana Old', initials: 'DO' }, created: '2019-05-01T08:00:00.000', pos: { x: 914400, y: 457200 } })
    expect(s2.threads[0]!.replies.map((r) => r.text)).toEqual(['Old reply'])
    expect(d.slides[2]!.comments).toEqual({ threads: [], legacyIgnored: 0, error: null })
  })

  it('a broken comment part does not stop the deck from opening: the slide says why', () => {
    const spec = commentedDeck()
    spec.parts!['/ppt/comments/modernComment_100_1.xml']!.bytes = strToU8('<p188:cmLst xmlns:p188="x"><oops></p188:cmLst>')
    const d = reread(buildPptx(spec))
    expect(d.slides[0]!.comments.threads).toEqual([])
    expect(d.slides[0]!.comments.error).toMatch(/could not be read/)
    expect(d.slides[1]!.comments.threads).toHaveLength(1)
  })

  it('a broken author list: the deck opens, slides with comments say why they show none', () => {
    const spec = commentedDeck()
    spec.parts!['/ppt/authors.xml']!.bytes = strToU8('<p188:authorLst xmlns:p188="x"><oops></p188:authorLst>')
    const d = reread(buildPptx(spec))
    expect(d.commentsError).toMatch(/comment authors could not be read/)
    expect(d.slides[0]!.comments.error).toBe(d.commentsError)
    expect(d.slides[2]!.comments.error).toBeNull()
  })

  it('a round trip with no edit is byte-identical', () => {
    const bytes = commentedPptx()
    const ed = open(bytes)
    expectSame(bytes, ed.toBytes())
  })
})

const at = '2026-11-21T12:00:00.000Z'

describe('comment operations', () => {
  it('adds a comment on a slide with a position: a new part, its relationship and content type, the author list made; undo exact', () => {
    const bytes = buildPptx({ slides: [{ shapes: sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para('Hi') }) }, { shapes: '' }] })
    const ed = open(bytes)
    const r = ed.apply({ kind: 'addComment', slide: S1, id: '{N1}', author: CAROL, created: at, text: 'Nice\nslide', anchor: { kind: 'slide' }, pos: { x: 100, y: 200 } })
    expect(r).not.toBeNull()
    const after = ed.toBytes()
    const t = reread(after).slides[0]!.comments.threads
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ id: '{N1}', format: 'modern', text: 'Nice\nslide', created: at, status: 'active', anchor: { kind: 'slide' }, pos: { x: 100, y: 200 }, author: { name: 'Carol Diaz', initials: 'CD', userId: 'm-carol', providerId: 'eigenEnterprise' } })
    // only comment parts, the relationships to them, the slide's reference to its part, and content types changed
    expect(changedEntries(bytes, after)).toEqual(
      ['[Content_Types].xml', 'ppt/_rels/presentation.xml.rels', 'ppt/authors.xml', 'ppt/comments/modernComment_100_1.xml', 'ppt/slides/_rels/slide1.xml.rels', 'ppt/slides/slide1.xml'].sort(),
    )
    const types = xmlOf(after, '[Content_Types].xml')
    expect(types).toContain('PartName="/ppt/authors.xml" ContentType="application/vnd.ms-powerpoint.authors+xml"')
    expect(types).toContain('PartName="/ppt/comments/modernComment_100_1.xml" ContentType="application/vnd.ms-powerpoint.comments+xml"')
    expect(xmlOf(after, 'ppt/_rels/presentation.xml.rels')).toContain(`Type="${REL_MODERN_AUTHORS}" Target="authors.xml"`)
    expect(xmlOf(after, 'ppt/slides/_rels/slide1.xml.rels')).toContain(`Type="${REL_MODERN_COMMENTS}" Target="../comments/modernComment_100_1.xml"`)
    const slideXml = xmlOf(after, 'ppt/slides/slide1.xml')
    expect(slideXml).toMatch(/<\/p:clrMapOvr><p:extLst><p:ext uri="\{6950BFC3-D8DA-4A85-94F7-54DA5524770B\}"><p188:commentRel [^>]*\/><\/p:ext><\/p:extLst><\/p:sld>$/)
    expect(slideXml).toMatch(new RegExp(`<p188:commentRel (?=[^>]*r:id="rId\\d+")(?=[^>]*xmlns:p188="${P188}")`))
    const cm = xmlOf(after, 'ppt/comments/modernComment_100_1.xml')
    expect(cm).toContain('<pc:sldMk cId="0" sldId="256"/>')
    ed.undo()
    expectSame(bytes, ed.toBytes())
    ed.redo()
    expectSame(after, ed.toBytes())
  })

  it('adds a comment on a shape (a shape moniker), reusing the author already in the list', () => {
    const bytes = commentedPptx()
    const ed = open(bytes)
    ed.apply({ kind: 'addComment', slide: S3, id: '{N2}', author: BOB, created: at, text: 'Move this', anchor: { kind: 'shape', shape: '3' }, pos: null })
    const after = ed.toBytes()
    const t = reread(after).slides[2]!.comments.threads[0]!
    expect(t).toMatchObject({ anchor: { kind: 'shape', shape: '3' }, authorId: '{B2}', pos: null })
    // Bob is already an author: the author list stays byte-identical
    expect(changedEntries(bytes, after)).toEqual(['[Content_Types].xml', 'ppt/comments/modernComment_102_1.xml', 'ppt/slides/_rels/slide3.xml.rels', 'ppt/slides/slide3.xml'])
    expect(xmlOf(after, 'ppt/comments/modernComment_102_1.xml')).toMatch(/<ac:deMkLst xmlns:ac="[^"]+" xmlns:pc="[^"]+"><pc:docMk\/><pc:sldMk cId="0" sldId="258"\/><ac:spMk id="3"\/><\/ac:deMkLst>/)
  })

  it('replies, resolves and reopens: only the comment part changes, other comments stay; undo restores the exact XML', () => {
    const bytes = commentedPptx()
    const ed = open(bytes)
    ed.apply({ kind: 'replyComment', slide: S1, comment: '{C2}', id: '{R9}', author: BOB, created: at, text: 'Done' })
    let after = ed.toBytes()
    expect(changedEntries(bytes, after)).toEqual([MC1])
    let d = reread(after)
    expect(d.slides[0]!.comments.threads[1]!.replies.map((r) => [r.id, r.text, r.author?.name])).toEqual([['{R9}', 'Done', 'Bob Brown']])
    expect(d.slides[0]!.comments.threads[0]!.replies).toHaveLength(2)
    // replyLst goes before the comment's own text (schema order)
    expect(xmlOf(after, MC1)).toMatch(/<\/ac:deMkLst><p188:replyLst><p188:reply id="\{R9\}"[^>]*><p188:txBody>.*<\/p188:replyLst><p188:txBody>/)

    ed.apply({ kind: 'setCommentStatus', slide: S1, comment: '{C1}', status: 'resolved' })
    d = reread(ed.toBytes())
    expect(d.slides[0]!.comments.threads[0]!.status).toBe('resolved')
    expect(ed.apply({ kind: 'setCommentStatus', slide: S1, comment: '{C1}', status: 'resolved' })).toBeNull()
    ed.apply({ kind: 'setCommentStatus', slide: S1, comment: '{C2}', status: 'active' })
    after = ed.toBytes()
    expect(changedEntries(bytes, after)).toEqual([MC1])
    expect(reread(after).slides[0]!.comments.threads[1]!.status).toBe('active')
    ed.undo()
    ed.undo()
    ed.undo()
    expectSame(bytes, ed.toBytes())
  })

  it('a reply by a member new to the deck adds them to the author list', () => {
    const bytes = commentedPptx()
    const ed = open(bytes)
    ed.apply({ kind: 'replyComment', slide: S1, comment: '{C1}', id: '{R8}', author: CAROL, created: at, text: 'Agreed' })
    const after = ed.toBytes()
    expect(changedEntries(bytes, after)).toEqual(['ppt/authors.xml', MC1])
    expect(xmlOf(after, 'ppt/authors.xml')).toContain('name="Alice Smith"')
    const reply = reread(after).slides[0]!.comments.threads[0]!.replies.at(-1)!
    expect(reply.author).toMatchObject({ name: 'Carol Diaz', userId: 'm-carol', providerId: 'eigenEnterprise' })
    expect(reply.authorId).toMatch(/^\{[0-9A-F-]{36}\}$/)
  })

  it('edits and deletes only your own comments and replies', () => {
    const bytes = commentedPptx()
    const ed = open(bytes)
    expect(() => ed.apply({ kind: 'editComment', slide: S1, comment: '{C1}', reply: null, author: BOB, text: 'Mine now' })).toThrow(/only edit your own/)
    expect(() => ed.apply({ kind: 'deleteComment', slide: S1, comment: '{C1}', reply: null, author: BOB })).toThrow(/only delete your own/)
    expect(() => ed.apply({ kind: 'editComment', slide: S1, comment: '{C2}', reply: null, author: CAROL, text: 'x' })).toThrow(/only edit your own/)
    expectSame(bytes, ed.toBytes())

    ed.apply({ kind: 'editComment', slide: S1, comment: '{C2}', reply: null, author: BOB, text: 'Much bigger box' })
    ed.apply({ kind: 'editComment', slide: S1, comment: '{C1}', reply: '{R1}', author: BOB, text: 'On it now.' })
    let d = reread(ed.toBytes())
    expect(d.slides[0]!.comments.threads[1]!.text).toBe('Much bigger box')
    expect(d.slides[0]!.comments.threads[0]!.replies[0]!.text).toBe('On it now.')

    ed.apply({ kind: 'deleteComment', slide: S1, comment: '{C1}', reply: '{R1}', author: BOB })
    ed.apply({ kind: 'deleteComment', slide: S1, comment: '{C3}', reply: null, author: BOB })
    d = reread(ed.toBytes())
    expect(d.slides[0]!.comments.threads.map((t) => t.id)).toEqual(['{C1}', '{C2}'])
    expect(d.slides[0]!.comments.threads[0]!.replies.map((r) => r.id)).toEqual(['{R2}'])
    expect(changedEntries(bytes, ed.toBytes())).toEqual([MC1])
    for (let i = 0; i < 4; i++) ed.undo()
    expectSame(bytes, ed.toBytes())
  })

  it('deleting the last comment of a slide removes its part, relationship and the slide reference: back to the original bytes', () => {
    const bytes = buildPptx({ slides: [{ shapes: '' }] })
    const ed = open(bytes)
    ed.apply({ kind: 'addComment', slide: S1, id: '{N1}', author: CAROL, created: at, text: 'One', anchor: { kind: 'slide' }, pos: null })
    ed.apply({ kind: 'deleteComment', slide: S1, comment: '{N1}', reply: null, author: CAROL })
    const after = ed.toBytes()
    expect(reread(after).slides[0]!.comments.threads).toEqual([])
    // the slide, its relationships and content types are the original again; the (empty) author list stays
    const changed = changedEntries(bytes, after)
    expect(changed).toEqual(['[Content_Types].xml', 'ppt/_rels/presentation.xml.rels', 'ppt/authors.xml'])
    expect(xmlOf(after, '[Content_Types].xml')).not.toContain('modernComment')
  })

  it('legacy comments are read-only', () => {
    const ed = open(commentedPptx())
    const legacy = ed.deck().slides[1]!.comments.threads[0]!
    expect(() => ed.apply({ kind: 'replyComment', slide: S2, comment: legacy.id, id: '{X}', author: BOB, created: at, text: 'Hi' })).toThrow(/read-only/)
    expect(() => ed.apply({ kind: 'setCommentStatus', slide: S2, comment: legacy.id, status: 'resolved' })).toThrow(/read-only/)
  })

  it('refuses empty text, unknown comments, and an author without a name', () => {
    const ed = open(commentedPptx())
    expect(() => ed.apply({ kind: 'replyComment', slide: S1, comment: '{C1}', id: '{X}', author: BOB, created: at, text: '  ' })).toThrow(/needs some text/)
    expect(() => ed.apply({ kind: 'setCommentStatus', slide: S1, comment: '{NOPE}', status: 'resolved' })).toThrow(/no comment/)
    expect(() => ed.apply({ kind: 'addComment', slide: S3, id: '{X}', author: { id: 'm-x', name: '' }, created: at, text: 'x', anchor: { kind: 'slide' }, pos: null })).toThrow(/signed-in author/)
  })

  it('deleting a slide takes its comment parts with it', () => {
    const ed = open(commentedPptx())
    ed.apply({ kind: 'deleteSlide', slide: S1 })
    const names = Object.keys(entries(ed.toBytes()))
    expect(names).not.toContain(MC1)
    expect(names).not.toContain('ppt/comments/comment1.xml')
    expect(names).toContain('ppt/comments/comment2.xml')
  })

  it('a duplicated slide does not copy the comments', () => {
    const ed = open(commentedPptx())
    ed.apply({ kind: 'duplicateSlide', slide: S1 })
    expect(ed.deck().slides[1]!.comments.threads).toEqual([])
    expect(ed.deck().slides[0]!.comments.threads).toHaveLength(3)
  })

  it('writes the p188 namespace', () => {
    const ed = open(buildPptx({ slides: [{ shapes: '' }] }))
    ed.apply({ kind: 'addComment', slide: S1, id: '{N1}', author: CAROL, created: at, text: 'One', anchor: { kind: 'slide' }, pos: null })
    expect(xmlOf(ed.toBytes(), 'ppt/authors.xml')).toContain(`xmlns:p188="${P188}"`)
  })
})
