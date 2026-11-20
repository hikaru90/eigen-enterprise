import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { OpcError } from '../ooxml/package'
import { openDeck, PptxError, sourceOf, type SpNode } from './model'
import { autonumber, resolveSlide, type RNode, type RParagraph, type RText } from './resolve'
import { buildPptx, graphicFrame, para, ph, pic, PNG_1PX, sp, TABLE_URI, xfrm, type DeckSpec } from './test-utils/build-pptx'

const deck = (spec: DeckSpec) => openDeck(buildPptx(spec)).deck
const slide0 = (spec: DeckSpec) => resolveSlide(deck(spec), 0)
const shapes = (nodes: RNode[]) => nodes.filter((n): n is Extract<RNode, { kind: 'shape' }> => n.kind === 'shape')
const named = (nodes: RNode[], name: string) => {
  const n = nodes.find((x) => 'name' in x && x.name === name)
  if (!n) throw new Error(`no node ${name}: ${nodes.map((x) => ('name' in x ? x.name : x.kind)).join(', ')}`)
  return n
}
const textOf = (n: RNode): RText => {
  if (n.kind !== 'shape' || !n.text) throw new Error(`${n.kind} has no text`)
  return n.text
}
const firstRun = (p: RParagraph) => p.runs[0]!
const pt = (v: number) => (v * 96) / 72

describe('deck structure', () => {
  it('reads slide order, size, layout → master → theme links and speaker notes', () => {
    const d = deck({
      size: { cx: 9144000, cy: 6858000 },
      slides: [{ notes: ['Say hello', 'Then the plan'] }, { layout: 2 }, { hidden: true }],
    })
    expect(d.size).toEqual({ cx: 9144000, cy: 6858000 })
    expect(d.slides.map((s) => [s.number, s.layout, s.hidden])).toEqual([
      [1, '/ppt/slideLayouts/slideLayout1.xml', false],
      [2, '/ppt/slideLayouts/slideLayout2.xml', false],
      [3, '/ppt/slideLayouts/slideLayout1.xml', true],
    ])
    expect(d.layouts['/ppt/slideLayouts/slideLayout2.xml']!.name).toBe('Title Slide')
    expect(d.masters['/ppt/slideMasters/slideMaster1.xml']!.theme).toBe('/ppt/theme/theme1.xml')
    expect(d.themes['/ppt/theme/theme1.xml']!.fonts.major.latin).toBe('Major Sans')
    expect(d.slides[0]!.notes!.paragraphs.map((p) => p.runs.map((r) => (r.kind === 'break' ? '' : r.text)).join(''))).toEqual(['Say hello', 'Then the plan'])
    expect(d.slides[1]!.notes).toBeNull()
  })

  it('keeps a link from model nodes to their source XML elements', () => {
    const d = deck({ slides: [{ shapes: sp({ id: 7, name: 'Box', xfrm: xfrm(0, 0, 100, 100), geom: 'rect', body: para('Hi') }) }] })
    const box = d.slides[0]!.shapes[0] as SpNode
    const src = sourceOf(box)
    expect(src?.part).toBe('/ppt/slides/slide1.xml')
    expect(src?.el.localName).toBe('sp')
    expect(sourceOf(box.text!.paragraphs[0]!)?.el.localName).toBe('p')
    expect(sourceOf(d.slides[0]!)?.el.localName).toBe('sld')
    // the model itself is plain data
    expect(() => JSON.stringify(d)).not.toThrow()
  })

  it('fails loud on files that are not decks', () => {
    expect(() => openDeck(strToU8('not a zip'))).toThrow(OpcError)
    const noPres = zipSync({ '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') })
    expect(() => openDeck(noPres)).toThrow(PptxError)
    expect(() => openDeck(noPres)).toThrow(/no presentation/)
  })
})

describe('placeholder inheritance (slide → layout → master, by idx and type)', () => {
  it('a title without its own position takes the master title frame, style and theme font', () => {
    const s = slide0({ slides: [{ shapes: sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para('Quarterly review') }) }] })
    const title = named(s.nodes, 'Title 1')
    expect(title.kind === 'shape' && title.frame).toMatchObject({ x: 838200 / 9525, y: 365125 / 9525, w: 10515600 / 9525 })
    const t = textOf(title)
    expect(t.anchor).toBe('ctr')
    const run = firstRun(t.paragraphs[0]!)
    expect(run.size).toBeCloseTo(pt(44))
    expect(run.fonts).toEqual(['Major Sans'])
    expect(run.fill).toEqual({ kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } })
    expect(t.paragraphs[0]!.bullet).toBeNull()
    expect(t.paragraphs[0]!.lineSpacing).toEqual({ pct: 0.9 })
  })

  it('layout list styles and body properties win over the master; the slide wins over both', () => {
    const s = slide0({
      slides: [
        {
          layout: 2,
          shapes:
            sp({ id: 2, name: 'Title 1', ph: ph('ctrTitle'), body: para('Launch') }) +
            sp({ id: 3, name: 'Subtitle 2', ph: ph('subTitle', 1), body: '<a:bodyPr anchor="ctr"/><a:lstStyle/>' + para('Big day', { rPr: '<a:rPr lang="en-US" sz="3200" b="1"/>' }) }),
        },
      ],
    })
    const title = textOf(named(s.nodes, 'Title 1'))
    expect(title.anchor).toBe('b')
    expect(title.paragraphs[0]!.align).toBe('ctr')
    expect(firstRun(title.paragraphs[0]!).size).toBeCloseTo(pt(60))
    const sub = textOf(named(s.nodes, 'Subtitle 2'))
    expect(sub.anchor).toBe('ctr')
    expect(sub.paragraphs[0]!.bullet).toBeNull()
    expect(firstRun(sub.paragraphs[0]!)).toMatchObject({ bold: true, fonts: ['Minor Sans', 'Minor EA'] })
    expect(firstRun(sub.paragraphs[0]!).size).toBeCloseTo(pt(32))
  })

  it('matches by idx first: an untyped content placeholder idx=1 takes the master body style', () => {
    const s = slide0({
      slides: [{ shapes: sp({ id: 3, name: 'Content', ph: ph(null, 1), xfrm: xfrm(0, 0, 9525000, 4762500), body: para('One', { pPr: '<a:pPr lvl="0"/>' }) + para('Two', { pPr: '<a:pPr lvl="1"/>' }) }) }],
    })
    const t = textOf(named(s.nodes, 'Content'))
    const [p1, p2] = t.paragraphs as [RParagraph, RParagraph]
    expect(p1.bullet).toMatchObject({ text: '•', fonts: ['Arial'] })
    expect(p1.marL).toBeCloseTo(24)
    expect(p1.indent).toBeCloseTo(-24)
    expect('px' in p1.spaceBefore && p1.spaceBefore.px).toBeCloseTo(pt(10))
    expect(firstRun(p1).size).toBeCloseTo(pt(28))
    expect(p2.bullet?.text).toBe('–')
    expect(p2.marL).toBeCloseTo(72)
    expect(firstRun(p2).size).toBeCloseTo(pt(24))
    expect(p1.bullet!.size).toBeCloseTo(firstRun(p1).size)
  })

  it('the slide colour map override flips text colours', () => {
    const s = slide0({
      slides: [
        {
          clrMapOvr: '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>',
          shapes: sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para('Dark') }),
        },
      ],
    })
    expect(firstRun(textOf(named(s.nodes, 'Title 1')).paragraphs[0]!).fill).toEqual({ kind: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } })
    expect(s.background).toEqual({ kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } })
  })

  it('empty placeholders draw nothing (their prompt text is for editing)', () => {
    const s = slide0({ slides: [{ shapes: sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para('') }) }] })
    expect(named(s.nodes, 'Title 1')).toMatchObject({ kind: 'shape', text: null })
  })
})

describe('text', () => {
  it('normAutofit scales fonts and reduces line spacing', () => {
    const s = slide0({
      slides: [{ shapes: sp({ id: 3, name: 'Body', ph: ph(null, 1), body: '<a:bodyPr><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr><a:lstStyle/>' + para('Lots of text') }) }],
    })
    const t = textOf(named(s.nodes, 'Body'))
    expect(firstRun(t.paragraphs[0]!).size).toBeCloseTo(pt(28) * 0.625)
    expect(t.paragraphs[0]!.lineSpacing).toEqual({ pct: 0.8 })
  })

  it('numbers autonumbered paragraphs per level, restarting after a shallower one', () => {
    const num = (scheme: string, lvl = 0, start = '') => `<a:pPr lvl="${lvl}"><a:buAutoNum type="${scheme}"${start}/></a:pPr>`
    const s = slide0({
      slides: [
        {
          shapes: sp({
            id: 3,
            name: 'Body',
            ph: ph(null, 1),
            body:
              para('a', { pPr: num('arabicPeriod') }) +
              para('b', { pPr: num('arabicPeriod') }) +
              para('b.i', { pPr: num('romanLcParenR', 1) }) +
              para('b.ii', { pPr: num('romanLcParenR', 1) }) +
              para('c', { pPr: num('arabicPeriod') }) +
              para('d.i', { pPr: num('romanLcParenR', 1) }) +
              para('', { pPr: num('arabicPeriod') }) +
              para('x', { pPr: num('alphaUcPeriod', 0, ' startAt="4"') }),
          }),
        },
      ],
    })
    const bullets = textOf(named(s.nodes, 'Body')).paragraphs.map((p) => p.bullet?.text ?? null)
    expect(bullets).toEqual(['1.', '2.', 'i)', 'ii)', '3.', 'i)', null, 'D.'])
    expect(autonumber('romanUcPeriod', 4)).toBe('IV.')
    expect(autonumber('arabicParenBoth', 12)).toBe('(12)')
    expect(autonumber('alphaLcParenR', 27)).toBe('aa)')
  })

  it('reads run formatting, hyperlinks (http/mailto only), breaks and slide number fields', () => {
    const s = slide0({
      slides: [
        {
          rels: [
            { id: 'rIdL1', type: 'hyperlink', target: 'https://example.com/a', external: true },
            { id: 'rIdL2', type: 'hyperlink', target: 'javascript:alert(1)', external: true },
          ],
          shapes: sp({
            id: 5,
            name: 'Text',
            xfrm: xfrm(0, 0, 3000000, 1000000),
            txBox: true,
            body:
              '<a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" vert="vert270"/><a:lstStyle/>' +
              '<a:p><a:r><a:rPr lang="en-US" i="1" u="sng" strike="sngStrike" baseline="30000" cap="small"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:latin typeface="Serif One"/></a:rPr><a:t>Styled</a:t></a:r>' +
              '<a:br><a:rPr lang="en-US"/></a:br>' +
              '<a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rIdL1"/></a:rPr><a:t>link</a:t></a:r>' +
              '<a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rIdL2"/></a:rPr><a:t>bad</a:t></a:r>' +
              '<a:fld id="{x}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld></a:p>',
          }),
        },
      ],
    })
    const t = textOf(named(s.nodes, 'Text'))
    expect(t).toMatchObject({ wrap: false, vert: 'vert270', box: { x: 0, y: 0 } })
    const [styled, br, link, bad, field] = t.paragraphs[0]!.runs
    expect(styled).toMatchObject({ text: 'Styled', italic: true, underline: 'sng', strike: 'sngStrike', baseline: 30, caps: 'small', fonts: ['Serif One', 'Minor EA'], fill: { kind: 'solid', color: { r: 255, g: 0, b: 0, a: 1 } } })
    expect(styled!.size).toBeCloseTo(pt(18))
    expect(br!.isBreak).toBe(true)
    expect(link).toMatchObject({ link: { kind: 'url', href: 'https://example.com/a' }, underline: 'sng', fill: { kind: 'solid', color: { r: 5, g: 99, b: 193, a: 1 } } })
    expect(bad!.link).toEqual({ kind: 'unsupported', what: 'javascript:alert(1)' })
    expect(field!.text).toBe('1')
  })
})

describe('shapes, fills, lines', () => {
  it('theme style references give fill, line and text colour (phClr)', () => {
    const style =
      '<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>' +
      '<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>'
    const s = slide0({ slides: [{ shapes: sp({ id: 4, name: 'Styled', xfrm: xfrm(0, 0, 952500, 952500), geom: 'ellipse', style, body: para('In') }) }] })
    const n = named(s.nodes, 'Styled') as Extract<RNode, { kind: 'shape' }>
    expect(n.fill).toEqual({ kind: 'solid', color: { r: 0x44, g: 0x72, b: 0xc4, a: 1 } })
    expect(n.line?.width).toBeCloseTo(12700 / 9525)
    expect(n.line?.fill.kind).toBe('solid')
    const run = firstRun(n.text!.paragraphs[0]!)
    expect(run.fill).toEqual({ kind: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } })
    expect(run.fonts).toEqual(['Minor Sans', 'Minor EA'])
  })

  it('own spPr beats the style: gradient fill, dashed line with arrowheads', () => {
    const spPr =
      '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs><a:gs pos="100000"><a:schemeClr val="accent2"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill>' +
      '<a:ln w="38100" cap="rnd"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:prstDash val="dash"/><a:round/><a:headEnd type="triangle" w="lg" len="sm"/><a:tailEnd type="stealth"/></a:ln>'
    const s = slide0({ slides: [{ shapes: sp({ id: 4, name: 'G', xfrm: xfrm(0, 0, 952500, 952500), geom: 'rect', spPr }) }] })
    const n = named(s.nodes, 'G') as Extract<RNode, { kind: 'shape' }>
    expect(n.fill).toMatchObject({ kind: 'gradient', linear: { angle: 90, scaled: true }, stops: [{ pos: 0 }, { pos: 1, color: { r: 0xed, g: 0x7d, b: 0x31, a: 1 } }] })
    expect(n.line).toMatchObject({ width: 4, dash: 'dash', cap: 'round', join: 'round', head: { type: 'triangle', w: 'lg', len: 'sm' }, tail: { type: 'stealth', w: 'med', len: 'med' } })
  })

  it('a zero-width line is a hairline, not invisible', () => {
    const s = slide0({ slides: [{ shapes: sp({ id: 4, name: 'H', xfrm: xfrm(0, 0, 952500, 0), geom: 'line', spPr: '<a:ln w="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>' }) }] })
    expect((named(s.nodes, 'H') as Extract<RNode, { kind: 'shape' }>).line?.width).toBe(1)
  })

  it('composes group transforms (child space → slide), including flips', () => {
    const child = sp({ id: 6, name: 'Child', xfrm: xfrm(500000, 0, 500000, 500000), geom: 'rect' })
    const grp = (extra: string) =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm${extra}><a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="1000000"/></a:xfrm></p:grpSpPr>${child}</p:grpSp>`
    const plain = slide0({ slides: [{ shapes: grp('') }] })
    const g = plain.nodes[0] as Extract<RNode, { kind: 'group' }>
    expect((g.children[0] as Extract<RNode, { kind: 'shape' }>).frame).toMatchObject({ x: 2000000 / 9525, y: 1000000 / 9525, w: 1000000 / 9525, h: 1000000 / 9525, flipH: false })
    const flipped = slide0({ slides: [{ shapes: grp(' flipH="1"') }] })
    const f = ((flipped.nodes[0] as Extract<RNode, { kind: 'group' }>).children[0] as Extract<RNode, { kind: 'shape' }>).frame
    expect(f.x).toBeCloseTo(1000000 / 9525)
    expect(f.flipH).toBe(true)
  })

  it('backgrounds: master bgRef by default, the slide’s own when it has one', () => {
    expect(slide0({ slides: [{}] }).background).toEqual({ kind: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } })
    const own = slide0({ slides: [{ bg: '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' }] })
    expect(own.background).toEqual({ kind: 'solid', color: { r: 0x44, g: 0x72, b: 0xc4, a: 1 } })
  })

  it('master and layout graphics show unless showMasterSp says no; placeholders never do', () => {
    const logo = sp({ id: 9, name: 'Logo', xfrm: xfrm(0, 0, 100000, 100000), geom: 'ellipse' })
    const master = { shapes: logo + sp({ id: 2, name: 'Title Placeholder 1', ph: ph('title'), xfrm: xfrm(0, 0, 1, 1), body: para('x') }) }
    expect(slide0({ master, slides: [{}] }).nodes.map((n) => ('name' in n ? n.name : ''))).toEqual(['Logo'])
    expect(slide0({ master, slides: [{ showMasterSp: false }] }).nodes).toEqual([])
    expect(slide0({ master, layouts: [{ showMasterSp: false }], slides: [{}] }).nodes).toEqual([])
  })

  it('an unknown preset and a chart are named, never dropped', () => {
    const s = slide0({
      slides: [{ shapes: sp({ id: 4, name: 'Cloud', xfrm: xfrm(0, 0, 952500, 952500), geom: 'cloud', body: para('Idea') }) + graphicFrame({ id: 5, name: 'Chart 1', x: 0, y: 0, cx: 100, cy: 100, uri: 'http://schemas.openxmlformats.org/drawingml/2006/chart', data: '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/>' }) }],
    })
    const cloud = named(s.nodes, 'Cloud') as Extract<RNode, { kind: 'shape' }>
    expect(cloud.unknownGeometry).toBe('cloud shape')
    expect(cloud.text?.paragraphs[0]!.runs[0]!.text).toBe('Idea')
    expect(named(s.nodes, 'Chart 1')).toMatchObject({ kind: 'placeholder', label: 'Chart — not shown yet' })
  })

  it('pictures: the image part, its type and the crop', () => {
    const s = slide0({
      parts: { '/ppt/media/image1.png': { bytes: PNG_1PX, type: 'image/png' } },
      slides: [{ rels: [{ id: 'rIdImg', type: 'image', target: '../media/image1.png' }], shapes: pic({ id: 4, name: 'Photo', rId: 'rIdImg', xfrm: xfrm(0, 0, 952500, 952500), crop: '<a:srcRect l="10000" r="20000"/>', descr: 'A harbour' }) }],
    })
    const p = named(s.nodes, 'Photo') as Extract<RNode, { kind: 'picture' }>
    expect(p.image.image).toEqual({ kind: 'part', part: '/ppt/media/image1.png', contentType: 'image/png' })
    expect(p.image.crop).toEqual({ l: 0.1, t: 0, r: 0.2, b: 0 })
    expect(p.descr).toBe('A harbour')
  })

  it('tables: grid, merges, table style parts and own cell fills', () => {
    const tableStyles = `<?xml version="1.0" encoding="UTF-8"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{S}"><a:tblStyle styleId="{S}" styleName="Test style">
      <a:wholeTbl><a:tcTxStyle><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:insideH><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:insideH></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>
      <a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:fill></a:tcStyle></a:band1H>
      <a:firstRow><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>
    </a:tblStyle></a:tblStyleLst>`
    const cell = (text: string, attrs = '', tcPr = '<a:tcPr/>') => `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${para(text)}</a:txBody>${tcPr}</a:tc>`
    const tbl =
      `<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{S}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="952500"/><a:gridCol w="1905000"/></a:tblGrid>` +
      `<a:tr h="381000">${cell('Head', ' gridSpan="2"')}${cell('', ' hMerge="1"')}</a:tr>` +
      `<a:tr h="381000">${cell('a')}${cell('b', '', '<a:tcPr marL="0"><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill></a:tcPr>')}</a:tr>` +
      `<a:tr h="381000">${cell('c')}${cell('d')}</a:tr></a:tbl>`
    const s = slide0({ tableStyles, slides: [{ shapes: graphicFrame({ id: 4, name: 'Table 1', x: 0, y: 0, cx: 2857500, cy: 1143000, uri: TABLE_URI, data: tbl }) }] })
    const t = (named(s.nodes, 'Table 1') as Extract<RNode, { kind: 'table' }>).table
    expect(t.cols).toEqual([100, 200])
    expect(t.missingStyle).toBeNull()
    const [head, merged] = t.rows[0]!.cells
    expect(head).toMatchObject({ colSpan: 2, covered: false, fill: { kind: 'solid', color: { r: 0x44, g: 0x72, b: 0xc4, a: 1 } } })
    expect(merged!.covered).toBe(true)
    expect(head!.paragraphs[0]!.runs[0]).toMatchObject({ bold: true, fill: { kind: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } } })
    const [a, b] = t.rows[1]!.cells
    expect(a!.fill).toEqual({ kind: 'solid', color: { r: 0xed, g: 0x7d, b: 0x31, a: 1 } })
    expect(a!.paragraphs[0]!.runs[0]).toMatchObject({ bold: false, fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } } })
    expect(b!.fill).toEqual({ kind: 'solid', color: { r: 255, g: 255, b: 0, a: 1 } })
    expect(b!.insets.l).toBe(0)
    // the second body row is band2H: no band fill, the whole-table tint shows; inner horizontal border from wholeTbl
    const c = t.rows[2]!.cells[0]!
    expect(c.fill.kind === 'solid' && c.fill.color.r).toBeGreaterThan(0x44)
    expect(c.borders.t?.width).toBeCloseTo(12700 / 9525)
    expect(c.borders.b).toBeNull()
  })

  it('a table whose style is not in the file says so', () => {
    const tbl = `<a:tbl><a:tblPr><a:tableStyleId>{NOPE}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="952500"/></a:tblGrid><a:tr h="381000"><a:tc><a:txBody><a:bodyPr/>${para('x')}</a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>`
    const s = slide0({ slides: [{ shapes: graphicFrame({ id: 4, name: 'T', x: 0, y: 0, cx: 952500, cy: 381000, uri: TABLE_URI, data: tbl }) }] })
    expect((named(s.nodes, 'T') as Extract<RNode, { kind: 'table' }>).table.missingStyle).toBe('{NOPE}')
  })

  it('markup compatibility: takes the fallback when the choice needs a namespace it does not know', () => {
    const ac = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p14="urn:future"><mc:Choice Requires="p14">${sp({ id: 8, name: 'Future' })}</mc:Choice><mc:Fallback>${sp({ id: 9, name: 'Fallback', xfrm: xfrm(0, 0, 10, 10), geom: 'rect' })}</mc:Fallback></mc:AlternateContent>`
    expect(shapes(slide0({ slides: [{ shapes: ac }] }).nodes).map((n) => n.name)).toEqual(['Fallback'])
  })
})
