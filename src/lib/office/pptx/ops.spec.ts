import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readPackage } from '../ooxml/package'
import { createDeckEditor } from './editor'
import { openDeck, sourceOf, walkShapes, type Deck, type PicNode, type ShapeNode, type SpNode } from './model'
import { applyOp, effectiveXfrm, relativeTarget, type DeckOp } from './ops'
import { resolveSlide } from './resolve'
import { buildPptx, para, ph, PNG_1PX, sp, xfrm, type DeckSpec } from './test-utils/build-pptx'
import { extractText } from './text'

const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const S1 = '/ppt/slides/slide1.xml'
const S2 = '/ppt/slides/slide2.xml'

function open(spec: DeckSpec | Uint8Array) {
  const bytes = spec instanceof Uint8Array ? spec : buildPptx(spec)
  const ed = createDeckEditor(readPackage(bytes))
  return { bytes, ed }
}

/** The ZIP entries of a package, by name (without "[Content_Types].xml"). */
function entries(bytes: Uint8Array): Record<string, Uint8Array> {
  const all = unzipSync(bytes)
  delete all['[Content_Types].xml']
  return all
}

/** Every entry of `after` that is in `before` and not in `changed` is byte-identical. */
function expectUntouched(before: Uint8Array, after: Uint8Array, changed: string[]) {
  const b = entries(before)
  const a = entries(after)
  const skip = new Set(changed.map((c) => c.replace(/^\//, '')))
  for (const [name, bytes] of Object.entries(b)) {
    if (skip.has(name)) continue
    expect(a[name], name).toBeDefined()
    expect(Buffer.from(a[name]!).equals(Buffer.from(bytes)), `${name} unchanged`).toBe(true)
  }
}

/** The package is the original again, part for part, byte for byte. */
function expectSame(before: Uint8Array, after: Uint8Array) {
  const b = entries(before)
  const a = entries(after)
  expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
  for (const [name, bytes] of Object.entries(b)) expect(Buffer.from(a[name]!).equals(Buffer.from(bytes)), `${name} restored`).toBe(true)
}

const xmlOf = (bytes: Uint8Array, part: string) => strFromU8(unzipSync(bytes)[part.replace(/^\//, '')]!)
const reread = (bytes: Uint8Array): Deck => openDeck(bytes).deck
const shape = (d: Deck, slide: number, id: string): ShapeNode => {
  const s = [...walkShapes(d.slides[slide]!.shapes)].find((x) => x.id === id)
  if (!s) throw new Error(`no shape ${id}`)
  return s
}
const textOf = (s: ShapeNode) => (s as SpNode).text!.paragraphs.map((p) => p.runs.map((r) => (r.kind === 'break' ? '\n' : r.text)).join(''))

const title = (text: string) => sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para(text) })
const RPR_EXT = '<a:rPr lang="en-US" dirty="0"><a:extLst><a:ext uri="{X-RUN}"><x:keep xmlns:x="urn:test"/></a:ext></a:extLst></a:rPr>'
const BOX = sp({ id: 3, name: 'Box', xfrm: xfrm(100000, 200000, 3000000, 1000000), geom: 'rect', spPr: '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:extLst><a:ext uri="{X-SPPR}"/></a:extLst>', body: para('Hello world', { rPr: RPR_EXT }) })
const BASE: DeckSpec = { slides: [{ shapes: title('First') + BOX, notes: ['Old note'] }, { shapes: title('Second') }] }

describe('relativeTarget', () => {
  it('writes OPC targets relative to the source folder', () => {
    expect(relativeTarget('/ppt/slides/slide1.xml', '/ppt/media/image1.png')).toBe('../media/image1.png')
    expect(relativeTarget('/ppt/presentation.xml', '/ppt/slides/slide3.xml')).toBe('slides/slide3.xml')
    expect(relativeTarget('/ppt/slides/slide1.xml', '/ppt/slides/slide2.xml')).toBe('slide2.xml')
  })
})

describe('text edits', () => {
  it('sets the text of a run: saved, re-read, other parts byte-identical, undo exact', () => {
    const { bytes, ed } = open(BASE)
    const r = ed.apply({ kind: 'setText', slide: S1, shape: '3', paragraphs: [{ from: 0, runs: [{ kind: 'text', text: 'Hello there', from: { p: 0, r: 0 } }] }] })
    expect(r?.touched).toEqual([S1])
    const after = ed.toBytes()
    const d = reread(after)
    expect(textOf(shape(d, 0, '3'))).toEqual(['Hello there'])
    expectUntouched(bytes, after, [S1])
    const xml = xmlOf(after, S1)
    // the run keeps its rPr and its extension; the shape keeps its spPr extension and fill
    expect(xml).toContain('<a:ext uri="{X-RUN}"><x:keep xmlns:x="urn:test"/></a:ext>')
    expect(xml).toContain('<a:ext uri="{X-SPPR}"/>')
    expect(xml).toContain('<a:srgbClr val="FF0000"/>')
    ed.undo()
    expectSame(bytes, ed.toBytes())
    expect(textOf(shape(ed.deck(), 0, '3'))).toEqual(['Hello world'])
    ed.redo()
    expect(textOf(shape(ed.deck(), 0, '3'))).toEqual(['Hello there'])
  })

  it('keeps unchanged paragraphs as they are (fields, breaks, extensions) and builds new ones from their sources', () => {
    const body =
      '<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" b="1"/><a:t>Keep me</a:t></a:r><a:br><a:rPr lang="en-US"/></a:br><a:fld id="{F1}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US" sz="1200"/></a:p>' +
      '<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US" i="1"/><a:t>Change me</a:t></a:r></a:p>'
    const { ed } = open({ slides: [{ shapes: sp({ id: 4, name: 'Text', xfrm: xfrm(0, 0, 100, 100), body }) }] })
    const before = sourceOf((shape(ed.deck(), 0, '4') as SpNode).text!.paragraphs[0]!)!.el
    ed.apply({
      kind: 'setText',
      slide: S1,
      shape: '4',
      paragraphs: [
        { from: 0, runs: [{ kind: 'text', text: 'Keep me', from: { p: 0, r: 0 } }, { kind: 'break', from: { p: 0, r: 1 } }, { kind: 'text', text: '1', from: { p: 0, r: 2 } }] },
        { from: 1, runs: [{ kind: 'text', text: 'Changed', from: { p: 1, r: 0 } }] },
        { from: 1, runs: [{ kind: 'text', text: 'and a new line', from: null }] },
      ],
    })
    const xml = xmlOf(ed.toBytes(), S1)
    expect(xml).toContain('<a:fld id="{F1}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US" sz="1200"/></a:p>')
    expect(xml).toContain('<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US" i="1"/><a:t>Changed</a:t></a:r></a:p>')
    // a run without a source takes its neighbours' formatting (here: none in the paragraph → the source paragraph's)
    expect(xml).toContain('<a:p><a:pPr lvl="1"/><a:r><a:t>and a new line</a:t></a:r></a:p>')
    const now = shape(ed.deck(), 0, '4') as SpNode
    expect(sourceOf(now.text!.paragraphs[0]!)!.el).toBe(before)
    expect(textOf(now)).toEqual(['Keep me\n‹#›', 'Changed', 'and a new line'])
  })

  it('formats part of a run by splitting it; the rest keeps its formatting', () => {
    const { bytes, ed } = open(BASE)
    ed.apply({ kind: 'formatRuns', slide: S1, shape: '3', range: { start: { p: 0, r: 0, o: 6 }, end: { p: 0, r: 0, o: 11 } }, format: { bold: true, color: 'c00000', size: 3200, italic: true, underline: true } })
    const s = shape(reread(ed.toBytes()), 0, '3') as SpNode
    const runs = s.text!.paragraphs[0]!.runs
    expect(runs.map((r) => (r.kind === 'run' ? r.text : ''))).toEqual(['Hello ', 'world'])
    expect(runs[0]!.props).toEqual({})
    expect(runs[1]!.props).toMatchObject({ bold: true, italic: true, underline: 'sng', size: 3200, fill: { kind: 'solid', color: { kind: 'srgb', hex: 'C00000' } } })
    const xml = xmlOf(ed.toBytes(), S1)
    expect(xml.match(/\{X-RUN\}/g)).toHaveLength(2)
    ed.undo()
    expectSame(bytes, ed.toBytes())
  })

  it('formats the whole text (all runs and paragraph ends) when there is no range', () => {
    const { ed } = open({ slides: [{ shapes: sp({ id: 4, xfrm: xfrm(0, 0, 100, 100), body: para('A') + para('') }) }] })
    ed.apply({ kind: 'formatRuns', slide: S1, shape: '4', range: null, format: { bold: false, size: 2000 } })
    const s = shape(ed.deck(), 0, '4') as SpNode
    expect(s.text!.paragraphs[0]!.runs[0]!.props).toMatchObject({ bold: false, size: 2000 })
    expect(s.text!.paragraphs[1]!.endProps).toMatchObject({ bold: false, size: 2000 })
  })

  it('aligns paragraphs and turns bullets off and back on', () => {
    const body = sp({ id: 3, name: 'Content', ph: ph(null, 1), body: para('One') + para('Two') })
    const box = sp({ id: 4, name: 'Box', xfrm: xfrm(0, 0, 100, 100), txBox: true, body: para('Plain') })
    const { ed } = open({ slides: [{ shapes: body + box }] })
    const bullets = (id: string) => resolveSlide(ed.deck(), 0).nodes.flatMap((n) => (n.kind === 'shape' && n.id === id ? n.text!.paragraphs.map((p) => p.bullet?.text ?? null) : []))
    expect(bullets('3')).toEqual(['•', '•'])
    ed.apply({ kind: 'formatParagraphs', slide: S1, shape: '3', paragraphs: [1], bullets: false, align: 'ctr' })
    expect(bullets('3')).toEqual(['•', null])
    expect((shape(ed.deck(), 0, '3') as SpNode).text!.paragraphs[1]!.props.align).toBe('ctr')
    ed.apply({ kind: 'formatParagraphs', slide: S1, shape: '3', paragraphs: null, bullets: true })
    // the placeholder's own (inherited) bullets come back, nothing explicit added
    expect(bullets('3')).toEqual(['•', '•'])
    expect(xmlOf(ed.toBytes(), S1)).not.toContain('buChar')
    // a text box has no inherited bullet: it gets a plain one
    ed.apply({ kind: 'formatParagraphs', slide: S1, shape: '4', paragraphs: null, bullets: true })
    expect(bullets('4')).toEqual(['•'])
    expect(xmlOf(ed.toBytes(), S1)).toContain('<a:pPr marL="285750" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>')
  })

  it('refuses text with raw line breaks and leaves the deck unchanged', () => {
    const { bytes, ed } = open(BASE)
    expect(() => ed.apply({ kind: 'setText', slide: S1, shape: '3', paragraphs: [{ from: 0, runs: [{ kind: 'text', text: 'a\nb', from: null }] }] })).toThrow(/line break/)
    expectSame(bytes, ed.toBytes())
    expect(ed.canUndo()).toBe(false)
  })

  it('text extraction for agents reflects edits', async () => {
    const { ed } = open(BASE)
    ed.apply({ kind: 'setText', slide: S1, shape: '2', paragraphs: [{ from: 0, runs: [{ kind: 'text', text: 'Renamed title', from: { p: 0, r: 0 } }] }] })
    ed.apply({ kind: 'setNotes', slide: S2, text: 'Fresh note' })
    const md = await extractText(ed.toBytes())
    expect(md).toContain('## Slide 1: Renamed title')
    expect(md).toContain('- Hello world')
    expect(md).toContain('## Slide 2: Second\n\n> Notes: Fresh note')
  })
})

describe('position, size, rotation', () => {
  it('moves, resizes and rotates a shape with its own xfrm, keeping everything else in spPr', () => {
    const { bytes, ed } = open(BASE)
    ed.apply({ kind: 'setXfrm', slide: S1, shape: '3', xfrm: { x: 500000, cy: 2000000, rot: 30 } })
    const s = shape(reread(ed.toBytes()), 0, '3') as SpNode
    expect(s.spPr.xfrm).toMatchObject({ x: 500000, y: 200000, cx: 3000000, cy: 2000000, rot: 30 })
    const xml = xmlOf(ed.toBytes(), S1)
    expect(xml).toContain('<a:xfrm rot="1800000"><a:off x="500000" y="200000"/><a:ext cx="3000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:extLst><a:ext uri="{X-SPPR}"/></a:extLst>')
    ed.apply({ kind: 'setXfrm', slide: S1, shape: '3', xfrm: { rot: 360 } })
    expect(xmlOf(ed.toBytes(), S1)).toContain('<a:xfrm><a:off x="500000"')
    ed.undo()
    ed.undo()
    expectSame(bytes, ed.toBytes())
  })

  it('gives a placeholder its own xfrm from the inherited one', () => {
    const { ed } = open(BASE)
    const d = ed.deck()
    const t = shape(d, 0, '2')
    expect((t as SpNode).spPr.xfrm).toBeNull()
    // the master's title area (the default layout's title has no position)
    expect(effectiveXfrm(d, d.slides[0]!, t)).toMatchObject({ x: 838200, y: 365125, cx: 10515600, cy: 1325563 })
    ed.apply({ kind: 'setXfrm', slide: S1, shape: '2', xfrm: { y: 100000 } })
    expect((shape(ed.deck(), 0, '2') as SpNode).spPr.xfrm).toMatchObject({ x: 838200, y: 100000, cx: 10515600, cy: 1325563, rot: 0 })
  })

  it('resizes a group by its own box; a missing child space is written so the children scale', () => {
    const grp =
      '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>' +
      sp({ id: 11, xfrm: xfrm(0, 0, 500, 500), geom: 'rect' }) +
      '</p:grpSp>'
    const { ed } = open({ slides: [{ shapes: grp }] })
    ed.apply({ kind: 'setXfrm', slide: S1, shape: '10', xfrm: { cx: 2000 } })
    expect(xmlOf(ed.toBytes(), S1)).toContain('<a:xfrm><a:off x="100" y="100"/><a:ext cx="2000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/></a:xfrm>')
    const g = shape(ed.deck(), 0, '10')
    expect(g.kind === 'group' && g.xfrm).toMatchObject({ cx: 2000, chCx: 1000 })
  })

  it('moves a shape inside mc:AlternateContent in every branch', () => {
    const alt = (branch: string) => sp({ id: 5, name: `Alt ${branch}`, xfrm: xfrm(10, 20, 30, 40), geom: 'rect' })
    const shapes = `<mc:AlternateContent xmlns:mc="${NS_MC}" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><mc:Choice Requires="a14">${alt('choice')}</mc:Choice><mc:Fallback>${alt('fallback')}</mc:Fallback></mc:AlternateContent>`
    const { ed } = open({ slides: [{ shapes }] })
    ed.apply({ kind: 'setXfrm', slide: S1, shape: '5', xfrm: { x: 999 } })
    const xml = xmlOf(ed.toBytes(), S1)
    expect(xml.match(/<a:off x="999" y="20"\/>/g)).toHaveLength(2)
    expect(xml).toContain('<mc:Choice Requires="a14">')
  })

  it('fails loud for an unknown shape and changes nothing', () => {
    const { bytes, ed } = open(BASE)
    expect(() => ed.apply({ kind: 'setXfrm', slide: S1, shape: '99', xfrm: { x: 1 } })).toThrow(/no shape 99/)
    expect(() => ed.apply({ kind: 'setXfrm', slide: '/ppt/slides/slide9.xml', shape: '3', xfrm: { x: 1 } })).toThrow(/no slide/)
    expectSame(bytes, ed.toBytes())
  })
})

describe('shapes: arrange, delete, duplicate, insert', () => {
  const ids = (d: Deck, i = 0) => d.slides[i]!.shapes.map((s) => s.id)

  it('brings forward and sends backward', () => {
    const { ed } = open(BASE)
    expect(ids(ed.deck())).toEqual(['2', '3'])
    ed.apply({ kind: 'arrange', slide: S1, shape: '2', dir: 'forward' })
    expect(ids(ed.deck())).toEqual(['3', '2'])
    expect(ed.apply({ kind: 'arrange', slide: S1, shape: '2', dir: 'forward' })).toBeNull()
    ed.apply({ kind: 'arrange', slide: S1, shape: '2', dir: 'backward' })
    expect(ids(ed.deck())).toEqual(['2', '3'])
  })

  it('deletes a shape (undo brings it back exactly)', () => {
    const { bytes, ed } = open(BASE)
    ed.apply({ kind: 'deleteShape', slide: S1, shape: '3' })
    expect(ids(reread(ed.toBytes()))).toEqual(['2'])
    ed.undo()
    expectSame(bytes, ed.toBytes())
  })

  it('duplicates a shape with fresh unique ids, offset, without the creation id', () => {
    const grp =
      '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group"><a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{1}"/></a:ext></a:extLst></p:cNvPr><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="1000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>' +
      sp({ id: 11, xfrm: xfrm(0, 0, 500, 500), geom: 'rect' }) +
      '</p:grpSp>'
    const { ed } = open({ slides: [{ shapes: title('T') + grp }] })
    const r = ed.apply({ kind: 'duplicateShape', slide: S1, shape: '10' })
    expect(r?.created).toEqual({ slide: S1, shape: '12' })
    const d = reread(ed.toBytes())
    const all = [...walkShapes(d.slides[0]!.shapes)].map((s) => s.id)
    expect(all).toEqual(['2', '10', '11', '12', '13'])
    expect(new Set(all).size).toBe(all.length)
    const copy = shape(d, 0, '12')
    expect(copy.kind === 'group' && copy.xfrm).toMatchObject({ x: 100 + 182880, y: 100 + 182880, chX: 0 })
    expect(xmlOf(ed.toBytes(), S1).match(/creationId/g)).toHaveLength(1)
  })

  it('duplicating a placeholder writes its inherited position, moved', () => {
    const { ed } = open(BASE)
    const r = ed.apply({ kind: 'duplicateShape', slide: S1, shape: '2' })
    const copy = shape(ed.deck(), 0, r!.created!.shape!) as SpNode
    expect(copy.ph).toEqual({ type: 'title', idx: null })
    expect(copy.spPr.xfrm).toMatchObject({ x: 838200 + 182880, y: 365125 + 182880 })
    expect(textOf(copy)).toEqual(['First'])
  })

  it('inserts a text box with a new id at the top', () => {
    const { bytes, ed } = open(BASE)
    const r = ed.apply({ kind: 'insertTextBox', slide: S1, box: { x: 10, y: 20, cx: 3000000, cy: 400000 }, text: 'New <text>\nline two' })
    expect(r?.created).toEqual({ slide: S1, shape: '4' })
    const d = reread(ed.toBytes())
    const box = shape(d, 0, '4') as SpNode
    expect(textOf(box)).toEqual(['New <text>', 'line two'])
    expect(box.spPr.xfrm).toMatchObject({ x: 10, y: 20, cx: 3000000, cy: 400000 })
    expectUntouched(bytes, ed.toBytes(), [S1])
  })

  it('inserts a picture: media part with its content type, a relationship, the p:pic; undo removes them', () => {
    const { bytes, ed } = open(BASE)
    const r = ed.apply({ kind: 'insertPicture', slide: S1, bytes: PNG_1PX, contentType: 'image/png', name: 'Logo' })
    expect(r?.touched.sort()).toEqual(['/ppt/media/image1.png', S1, '/ppt/slides/_rels/slide1.xml.rels'].sort())
    const after = ed.toBytes()
    const { pkg, deck } = openDeck(after)
    expect(pkg.contentType('/ppt/media/image1.png')).toBe('image/png')
    const pic = shape(deck, 0, '4') as PicNode
    expect(pic.kind).toBe('pic')
    expect(pic.name).toBe('Logo')
    expect(pic.blip.image).toEqual({ kind: 'part', part: '/ppt/media/image1.png', contentType: 'image/png' })
    // centred at natural size (1 px)
    expect(pic.spPr.xfrm).toMatchObject({ cx: 9525, cy: 9525, x: Math.round((12192000 - 9525) / 2) })
    expectUntouched(bytes, after, [S1, '/ppt/slides/_rels/slide1.xml.rels'])
    ed.undo()
    expectSame(bytes, ed.toBytes())
    expect(() => ed.apply({ kind: 'insertPicture', slide: S1, bytes: PNG_1PX, contentType: 'image/x-emf', name: 'x' })).toThrow(/PNG, JPEG, GIF or BMP/)
  })
})

describe('slides', () => {
  const sldIds = (bytes: Uint8Array) => [...xmlOf(bytes, '/ppt/presentation.xml').matchAll(/<p:sldId id="(\d+)" r:id="(\w+)"\/>/g)].map((m) => m[1])
  const order = (d: Deck) => d.slides.map((s) => s.part)

  it('adds a slide from a layout, with that layout’s placeholders (not the furniture)', () => {
    const { bytes, ed } = open(BASE)
    const r = ed.apply({ kind: 'addSlide', layout: '/ppt/slideLayouts/slideLayout2.xml', at: 1 })
    expect(r?.created).toEqual({ slide: '/ppt/slides/slide3.xml' })
    const after = ed.toBytes()
    const { pkg, deck } = openDeck(after)
    expect(order(deck)).toEqual([S1, '/ppt/slides/slide3.xml', S2])
    expect(deck.slides[1]!.layout).toBe('/ppt/slideLayouts/slideLayout2.xml')
    expect(deck.slides[1]!.shapes.map((s) => [s.name, s.ph])).toEqual([
      ['Title 1', { type: 'ctrTitle', idx: null }],
      ['Subtitle 2', { type: 'subTitle', idx: 1 }],
    ])
    expect(pkg.contentType('/ppt/slides/slide3.xml')).toBe('application/vnd.openxmlformats-officedocument.presentationml.slide+xml')
    const ids = sldIds(after)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual(['256', '258', '257'])
    // the new slide draws (placeholders inherit their positions)
    expect(() => resolveSlide(deck, 1, { editing: true })).not.toThrow()
    expectUntouched(bytes, after, ['/ppt/presentation.xml', '/ppt/_rels/presentation.xml.rels'])
    ed.undo()
    expectSame(bytes, ed.toBytes())
  })

  it('duplicates a slide and its notes, right after it', () => {
    const { ed } = open(BASE)
    const r = ed.apply({ kind: 'duplicateSlide', slide: S1 })
    const copy = r!.created!.slide
    const { pkg, deck } = openDeck(ed.toBytes())
    expect(order(deck)).toEqual([S1, copy, S2])
    expect(pkg.bytes(copy)).toEqual(pkg.bytes(S1))
    expect(textOf(shape(deck, 1, '3'))).toEqual(['Hello world'])
    const notes = pkg.relationships(copy).find((x) => x.type.endsWith('/notesSlide'))!.part!
    expect(notes).not.toBe('/ppt/notesSlides/notesSlide1.xml')
    expect(pkg.relationships(notes).find((x) => x.type.endsWith('/slide'))!.part).toBe(copy)
    expect(deck.slides[1]!.notes!.paragraphs[0]!.runs[0]).toMatchObject({ text: 'Old note' })
    // editing the copy's notes leaves the original's alone
    ed.apply({ kind: 'setNotes', slide: copy, text: 'Copy note' })
    expect(ed.deck().slides[0]!.notes!.paragraphs[0]!.runs[0]).toMatchObject({ text: 'Old note' })
  })

  it('deletes a slide with its notes; custom shows and sections stay valid', () => {
    const base = buildPptx(BASE)
    const pkg0 = readPackage(base)
    const pres = pkg0.text('/ppt/presentation.xml')
    pkg0.setBytes(
      '/ppt/presentation.xml',
      strToU8(
        pres
          .replace('<p:defaultTextStyle>', '<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rId10"/><p:sld r:id="rId11"/></p:sldLst></p:custShow></p:custShowLst><p:defaultTextStyle>')
          .replace(
            '</p:presentation>',
            '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="Intro" id="{A}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section><p14:section name="Rest" id="{B}"><p14:sldIdLst><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>',
          ),
      ),
    )
    const { bytes, ed } = open(pkg0.toBytes())
    ed.apply({ kind: 'deleteSlide', slide: S1 })
    const after = ed.toBytes()
    const { pkg, deck } = openDeck(after)
    expect(order(deck)).toEqual([S2])
    expect(deck.slides[0]!.number).toBe(1)
    for (const gone of [S1, '/ppt/slides/_rels/slide1.xml.rels', '/ppt/notesSlides/notesSlide1.xml', '/ppt/notesSlides/_rels/notesSlide1.xml.rels']) expect(pkg.has(gone), gone).toBe(false)
    const xml = xmlOf(after, '/ppt/presentation.xml')
    expect(xml).toContain('<p:sldLst><p:sld r:id="rId11"/></p:sldLst>')
    expect(xml).toContain('<p14:sldIdLst/>')
    expect(xml).not.toContain('<p14:sldId id="256"/>')
    expect(pkg.relationships('/ppt/presentation.xml').some((r) => r.id === 'rId10')).toBe(false)
    ed.undo()
    expectSame(bytes, ed.toBytes())
    // a moved slide joins the section of the slide before it
    ed.apply({ kind: 'moveSlide', slide: S2, to: 0 })
    const moved = xmlOf(ed.toBytes(), '/ppt/presentation.xml')
    expect(moved).toContain('<p14:section name="Intro" id="{A}"><p14:sldIdLst><p14:sldId id="257"/><p14:sldId id="256"/></p14:sldIdLst></p14:section><p14:section name="Rest" id="{B}"><p14:sldIdLst/>')
  })

  it('reorders slides by changing only presentation.xml', () => {
    const { bytes, ed } = open({ slides: [{ shapes: title('A') }, { shapes: title('B') }, { shapes: title('C') }] })
    ed.apply({ kind: 'moveSlide', slide: '/ppt/slides/slide3.xml', to: 0 })
    expect(order(ed.deck())).toEqual(['/ppt/slides/slide3.xml', S1, S2])
    ed.apply({ kind: 'moveSlide', slide: S1, to: 2 })
    expect(order(ed.deck())).toEqual(['/ppt/slides/slide3.xml', S2, S1])
    expect(ed.deck().slides.map((s) => s.number)).toEqual([1, 2, 3])
    expectUntouched(bytes, ed.toBytes(), ['/ppt/presentation.xml'])
    expect(ed.apply({ kind: 'moveSlide', slide: S1, to: 2 })).toBeNull()
  })

  it('hides and shows a slide', () => {
    const { bytes, ed } = open(BASE)
    ed.apply({ kind: 'setHidden', slide: S2, hidden: true })
    expect(reread(ed.toBytes()).slides[1]!.hidden).toBe(true)
    expect(ed.apply({ kind: 'setHidden', slide: S2, hidden: true })).toBeNull()
    ed.apply({ kind: 'setHidden', slide: S2, hidden: false })
    expect(ed.deck().slides[1]!.hidden).toBe(false)
    ed.undo()
    ed.undo()
    expectSame(bytes, ed.toBytes())
  })
})

describe('speaker notes', () => {
  it('edits existing notes, keeping unchanged lines as they were', () => {
    const { bytes, ed } = open({ slides: [{ shapes: title('A'), notes: ['Keep', 'Old'] }] })
    ed.apply({ kind: 'setNotes', slide: S1, text: 'Keep\nNew\nThird' })
    const notes = reread(ed.toBytes()).slides[0]!.notes!
    expect(notes.paragraphs.map((p) => p.runs.map((r) => (r.kind === 'break' ? '' : r.text)).join(''))).toEqual(['Keep', 'New', 'Third'])
    expectUntouched(bytes, ed.toBytes(), ['/ppt/notesSlides/notesSlide1.xml'])
  })

  it('creates a notes slide (and a notes master) for a slide without notes', () => {
    const { bytes, ed } = open({ slides: [{ shapes: title('A') }] })
    expect(ed.apply({ kind: 'setNotes', slide: S1, text: '' })).toBeNull()
    ed.apply({ kind: 'setNotes', slide: S1, text: 'Remember the demo' })
    const after = ed.toBytes()
    const { pkg, deck } = openDeck(after)
    expect(deck.slides[0]!.notes!.paragraphs[0]!.runs[0]).toMatchObject({ text: 'Remember the demo' })
    const notes = pkg.relationships(S1).find((r) => r.type.endsWith('/notesSlide'))!.part!
    const master = pkg.relationships(notes).find((r) => r.type.endsWith('/notesMaster'))!.part!
    expect(pkg.contentType(master)).toBe('application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml')
    expect(pkg.relationships('/ppt/presentation.xml').some((r) => r.part === master)).toBe(true)
    expect(xmlOf(after, '/ppt/presentation.xml')).toMatch(/<\/p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId\d+"\/><\/p:notesMasterIdLst><p:sldIdLst>/)
    const theme = pkg.relationships(master).find((r) => r.type.endsWith('/theme'))!.part!
    expect(theme).not.toBe('/ppt/theme/theme1.xml')
    ed.undo()
    expectSame(bytes, ed.toBytes())
  })
})

describe('history', () => {
  it('a batch is one undo step; redo replays it; the package reads back each time', () => {
    const { bytes, ed } = open(BASE)
    const batch: DeckOp = {
      kind: 'batch',
      ops: [
        { kind: 'setXfrm', slide: S1, shape: '3', xfrm: { x: 1 } },
        { kind: 'addSlide', layout: '/ppt/slideLayouts/slideLayout1.xml', at: 2 },
        { kind: 'setHidden', slide: S2, hidden: true },
      ],
    }
    ed.apply(batch)
    const once = ed.toBytes()
    expect(ed.deck().slides).toHaveLength(3)
    ed.undo()
    expectSame(bytes, ed.toBytes())
    expect(ed.canUndo()).toBe(false)
    ed.redo()
    expectSame(once, ed.toBytes())
    expect(ed.version()).toBe(3)
  })

  it('applyOp on its own returns the exact inverse', () => {
    const pkg = readPackage(buildPptx(BASE))
    const before = pkg.toBytes()
    const r = applyOp(pkg, { kind: 'deleteSlide', slide: S2 })
    expect(r.touched).toContain(S2)
    applyOp(pkg, r.inverse)
    expectSame(before, pkg.toBytes())
  })
})
