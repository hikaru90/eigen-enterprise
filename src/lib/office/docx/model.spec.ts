import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { DocxError, paragraphText, parseDocx, parseFieldInstruction, type Block, type Inline, type Paragraph, type Table } from './model'
import { buildDocx, inlineImage, p, PNG_1PX, r, sectPr } from './test-utils/builder'

const paras = (blocks: Block[]) => blocks.filter((b): b is Paragraph => b.type === 'paragraph')
const firstPara = (bytes: Uint8Array) => paras(parseDocx(bytes).sections[0]!.blocks)[0]!
const texts = (inlines: Inline[]) => inlines.filter((i) => i.type === 'text')

const STYLES = `
<w:docDefaults>
  <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="MS Mincho" w:cs="Arial"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:jc w:val="center"/><w:spacing w:before="240"/><w:ind w:left="720"/></w:pPr>
  <w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Derived"><w:name w:val="Derived"/><w:basedOn w:val="Base"/>
  <w:pPr><w:outlineLvl w:val="1"/><w:ind w:firstLine="360"/></w:pPr>
  <w:rPr><w:i/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="LooksLikeHeading"><w:name w:val="heading 1"/></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style>
<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/><w:u w:val="double"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>
  <w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="Grid"><w:name w:val="Grid"/><w:basedOn w:val="TableNormal"/>
  <w:tblPr><w:tblBorders><w:top w:val="single" w:sz="8" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="999999"/><w:insideV w:val="dashed" w:sz="4" w:color="999999"/></w:tblBorders></w:tblPr>
  <w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="4472C4"/></w:tcPr></w:tblStylePr>
  <w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr></w:tblStylePr>
</w:style>`

describe('docx model: styles and the formatting hierarchy (§17.7)', () => {
  it('applies document defaults, the basedOn chain, then direct formatting', () => {
    const para = firstPara(
      buildDocx({
        styles: STYLES,
        body: p(r('Title') + r('plain', '<w:b w:val="0"/><w:color w:val="FF0000"/>'), '<w:pStyle w:val="Derived"/><w:spacing w:after="0"/>') + sectPr(),
      }),
    )
    expect(para.props.styleId).toBe('Derived')
    expect(para.props.align).toBe('center')
    expect(para.props.outlineLevel).toBe(1)
    expect(para.props.indent).toEqual({ startPt: 36, firstLinePt: 18 })
    expect(para.props.spacing).toMatchObject({ beforePt: 12, afterPt: 0, line: { rule: 'auto', multiple: 259 / 240 } })
    const [title, plain] = texts(para.inlines)
    expect(title!.run).toMatchObject({ bold: true, italic: true, sizePt: 14, color: '#1f3864', fonts: { ascii: 'Calibri', eastAsia: 'MS Mincho' } })
    expect(plain!.run).toMatchObject({ bold: false, color: '#ff0000', sizePt: 14 })
  })

  it('treats bold/italic as toggles across style layers: a bold character style on a bold paragraph style turns bold off', () => {
    const para = firstPara(
      buildDocx({ styles: STYLES, body: p(r('x', '<w:rStyle w:val="Strong"/>'), '<w:pStyle w:val="Base"/>') + sectPr() }),
    )
    expect(texts(para.inlines)[0]!.run).toMatchObject({ bold: false, underline: 'double' })
  })

  it('uses the default paragraph style when none is named and keeps the style chain out of semantic guesses', () => {
    const doc = parseDocx(buildDocx({ styles: STYLES, body: p(r('a')) + p(r('b'), '<w:pStyle w:val="LooksLikeHeading"/>') + sectPr() }))
    const [a, b] = paras(doc.sections[0]!.blocks)
    expect(a!.props.styleId).toBe('Normal')
    expect(a!.props.spacing?.afterPt).toBe(8)
    // A style *named* "heading 1" is not a heading: only w:outlineLvl makes one.
    expect(b!.props.outlineLevel).toBeUndefined()
  })

  it('resolves theme fonts (w:asciiTheme) through the theme part', () => {
    const para = firstPara(
      buildDocx({
        fontScheme: '<a:fontScheme name="F"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Yu Mincho"/><a:cs typeface=""/></a:minorFont></a:fontScheme>',
        body: p(r('x', '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:eastAsiaTheme="minorEastAsia" w:ascii="Ignored"/>')) + sectPr(),
      }),
    )
    expect(texts(para.inlines)[0]!.run.fonts).toEqual({ ascii: 'Calibri Light', hAnsi: 'Calibri Light', eastAsia: 'Yu Mincho' })
  })

  it('reads run formatting: underline, strike, caps, highlight, shading, superscript, spacing, hidden text', () => {
    const para = firstPara(
      buildDocx({
        body:
          p(
            r(
              'x',
              '<w:u w:val="wave" w:color="00FF00"/><w:strike/><w:dstrike w:val="false"/><w:caps/><w:smallCaps w:val="0"/><w:highlight w:val="yellow"/><w:shd w:val="clear" w:fill="EEEEEE"/><w:vertAlign w:val="superscript"/><w:spacing w:val="20"/><w:vanish/>',
            ),
          ) + sectPr(),
      }),
    )
    expect(texts(para.inlines)[0]!.run).toMatchObject({
      underline: 'wave',
      underlineColor: '#00ff00',
      strike: true,
      doubleStrike: false,
      caps: true,
      smallCaps: false,
      highlight: 'yellow',
      shading: '#eeeeee',
      vertAlign: 'superscript',
      spacingPt: 1,
      vanish: true,
    })
  })
})

describe('docx model: paragraphs', () => {
  it('reads alignment, indents (hanging), spacing rules, keep options, page breaks and tab stops', () => {
    const doc = parseDocx(
      buildDocx({
        body:
          p(
            r('a') + '<w:r><w:tab/><w:t>b</w:t><w:br w:type="page"/><w:t>c</w:t><w:br/></w:r>',
            '<w:keepNext/><w:keepLines/><w:pageBreakBefore/><w:jc w:val="both"/><w:ind w:left="1440" w:right="720" w:hanging="360"/><w:spacing w:before="120" w:after="240" w:line="360" w:lineRule="exact"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9000"/><w:tab w:val="center" w:pos="4500"/></w:tabs>',
          ) + sectPr(),
      }),
    )
    const para = paras(doc.sections[0]!.blocks)[0]!
    expect(para.props).toMatchObject({
      align: 'justify',
      keepNext: true,
      keepLines: true,
      pageBreakBefore: true,
      indent: { startPt: 72, endPt: 36, firstLinePt: -18 },
      spacing: { beforePt: 6, afterPt: 12, line: { rule: 'exact', pt: 18 } },
      tabs: [
        { align: 'center', posPt: 225, leader: 'none' },
        { align: 'end', posPt: 450, leader: 'dot' },
      ],
    })
    expect(para.inlines.map((i) => (i.type === 'break' ? `br:${i.kind}` : i.type))).toEqual(['text', 'tab', 'text', 'br:page', 'text', 'br:line'])
  })

  it('marks right-to-left paragraphs and runs (w:bidi, w:rtl) and keeps complex-script formatting', () => {
    const para = firstPara(
      buildDocx({ body: p(r('שלום', '<w:rtl/><w:bCs/><w:szCs w:val="28"/><w:rFonts w:cs="David"/>'), '<w:bidi/><w:jc w:val="left"/>') + sectPr() }),
    )
    expect(para.props.bidi).toBe(true)
    // In a bidi paragraph "left" is the leading edge: we keep it logical.
    expect(para.props.align).toBe('start')
    expect(texts(para.inlines)[0]!.run).toMatchObject({ rtl: true, boldCs: true, sizeCsPt: 14, fonts: { cs: 'David' } })
  })

  it('keeps the source element on every node', () => {
    const para = firstPara(buildDocx({ body: p(r('hi')) + sectPr() }))
    expect(para.source.localName).toBe('p')
    expect(texts(para.inlines)[0]!.source.localName).toBe('t')
  })
})

const NUMBERING = `
<w:abstractNum w:abstractNumId="1">
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
  <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="(%3)"/></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="2">
  <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:rPr><w:rFonts w:ascii="Symbol"/></w:rPr></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="3">
  <w:lvl w:ilvl="0"><w:start w:val="4"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="Article %1"/></w:lvl>
  <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/><w:isLgl/><w:lvlRestart w:val="0"/></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="4"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="10"/></w:lvlOverride></w:num>
<w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>`

const li = (text: string, numId: string, ilvl = 0) => p(r(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`)

describe('docx model: numbering (§17.9)', () => {
  const labels = (body: string) =>
    paras(parseDocx(buildDocx({ numbering: NUMBERING, body: body + sectPr() })).sections[0]!.blocks).map((x) => x.list?.text ?? null)

  it('counts multi-level lists with level formats and restarts deeper levels', () => {
    expect(labels(li('a', '1') + li('b', '1', 1) + li('c', '1', 1) + li('d', '1', 2) + li('e', '1') + li('f', '1', 1) + p(r('plain')))).toEqual([
      '1.',
      '1.a)',
      '1.b)',
      '(i)',
      '2.',
      '2.a)',
      null,
    ])
  })

  it('continues the list across num instances of one abstract definition; startOverride restarts it', () => {
    expect(labels(li('a', '1') + li('b', '3') + li('c', '4') + li('d', '4') + li('e', '1'))).toEqual(['1.', '2.', '10.', '11.', '12.'])
  })

  it('formats bullets, roman numerals, legal numbering and lvlRestart 0', () => {
    expect(labels(li('a', '2') + li('b', '5') + li('c', '5', 1) + li('d', '5') + li('e', '5', 1))).toEqual(['•', 'Article IV', '4.1', 'Article V', '5.2'])
  })

  it('applies the level indent between the style and direct formatting, and gives the marker its run formatting', () => {
    const doc = parseDocx(buildDocx({ numbering: NUMBERING, body: li('a', '1', 1) + li('b', '2') + p(r('x'), '<w:numPr><w:numId w:val="0"/></w:numPr>') + sectPr() }))
    const [a, b, c] = paras(doc.sections[0]!.blocks)
    expect(a!.props.indent).toEqual({ startPt: 72, firstLinePt: -18 })
    expect(a!.list).toMatchObject({ ilvl: 1, value: 1, level: { suffix: 'tab' } })
    expect(b!.list?.markerRun.fonts?.ascii).toBe('Symbol')
    expect(c!.list).toBeNull()
  })

  it('takes numbering from the paragraph style', () => {
    const doc = parseDocx(
      buildDocx({
        numbering: NUMBERING,
        styles: '<w:style w:type="paragraph" w:styleId="ListPara"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>',
        body: p(r('a'), '<w:pStyle w:val="ListPara"/>') + p(r('b'), '<w:pStyle w:val="ListPara"/>') + sectPr(),
      }),
    )
    expect(paras(doc.sections[0]!.blocks).map((x) => x.list?.text)).toEqual(['1.', '2.'])
  })
})

describe('docx model: sections, headers and footers (§17.6, §17.10)', () => {
  it('reads page size, orientation, margins and columns per section, and inherits header/footer references', () => {
    const doc = parseDocx(
      buildDocx({
        headers: { rIdH1: p(r('Header default')), rIdH2: p(r('Header first')), rIdH3: p(r('Header even')) },
        footers: { rIdF1: p(r('Footer')) },
        settings: '<w:evenAndOddHeaders/><w:defaultTabStop w:val="708"/>',
        body:
          p(r('one')) +
          p(
            r('end of 1'),
            `<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:headerReference w:type="first" r:id="rIdH2"/><w:footerReference w:type="default" r:id="rIdF1"/><w:titlePg/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`,
          ) +
          p(r('two')) +
          sectPr(
            '<w:headerReference w:type="even" r:id="rIdH3"/><w:type w:val="continuous"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/><w:cols w:num="2" w:space="720"/><w:pgNumType w:start="5" w:fmt="lowerRoman"/>',
          ),
      }),
    )
    expect(doc.settings).toEqual({ defaultTabStopPt: 35.4, evenAndOddHeaders: true, trackRevisions: false })
    expect(doc.sections).toHaveLength(2)
    const [s1, s2] = doc.sections
    expect(paras(s1!.blocks).map(paragraphText)).toEqual(['one', 'end of 1'])
    expect(s1!.props).toMatchObject({ pageWidthPt: 612, pageHeightPt: 792, titlePage: true, margin: { leftPt: 90, headerPt: 36 }, columns: { count: 1 } })
    expect(s2!.props).toMatchObject({
      orientation: 'landscape',
      pageWidthPt: 841.9,
      start: 'continuous',
      columns: { count: 2, spacePt: 36 },
      pageNumbers: { start: 5, format: 'lowerRoman' },
      titlePage: false,
    })
    expect(s2!.props.headers).toEqual({ default: '/word/header-rIdH1.xml', first: '/word/header-rIdH2.xml', even: '/word/header-rIdH3.xml' })
    expect(s2!.props.footers).toEqual({ default: '/word/footer-rIdF1.xml' })
    expect(paras(doc.headerFooters.get('/word/header-rIdH3.xml')!).map(paragraphText)).toEqual(['Header even'])
  })
})

describe('docx model: tables (§17.4)', () => {
  const table = (bytes: Uint8Array) => parseDocx(bytes).sections[0]!.blocks.find((b): b is Table => b.type === 'table')!
  const cell = (text: string, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${p(r(text))}</w:tc>`

  it('reads the grid, spans, vertical merges, borders, shading and cell margins, with the table style and its regions', () => {
    const t = table(
      buildDocx({
        styles: STYLES,
        body:
          `<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="04A0"/></w:tblPr>` +
          `<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/><w:gridCol w:w="4000"/></w:tblGrid>` +
          `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell('Head', '<w:gridSpan w:val="2"/>')}${cell('C')}</w:tr>` +
          `<w:tr>${cell('Merged', '<w:vMerge w:val="restart"/>')}${cell('x')}${cell('y', '<w:shd w:val="clear" w:fill="FFFF00"/><w:tcMar><w:left w:w="0" w:type="dxa"/></w:tcMar>')}</w:tr>` +
          `<w:tr>${cell('', '<w:vMerge/>')}${cell('z')}${cell('w', '<w:tcBorders><w:bottom w:val="double" w:sz="12" w:color="FF0000"/></w:tcBorders>')}</w:tr>` +
          `</w:tbl>` +
          p(r('after')) +
          sectPr(),
      }),
    )
    expect(t.grid).toEqual([100, 150, 200])
    expect(t.props).toMatchObject({ styleId: 'Grid', width: { type: 'pct', value: 100 }, look: { firstRow: true, firstColumn: true, noVBand: true } })
    expect(t.rows[0]!.props.header).toBe(true)
    expect(t.rows[0]!.cells.map((c) => [c.gridCol, c.span])).toEqual([
      [0, 2],
      [2, 1],
    ])
    const [r1, r2] = [t.rows[1]!, t.rows[2]!]
    expect(r1.cells[0]!.props.vMerge).toBe('restart')
    expect(r2.cells[0]!.props.vMerge).toBe('continue')
    // Header row: the firstRow region shades it and bolds its text.
    expect(t.rows[0]!.cells[0]!.props.shading).toBe('#4472c4')
    expect(texts(paras(t.rows[0]!.cells[0]!.blocks)[0]!.inlines)[0]!.run.bold).toBe(true)
    // First body row is band 1: shaded unless the cell says otherwise.
    expect(r1.cells[1]!.props.shading).toBe('#d9e2f3')
    expect(r1.cells[2]!.props.shading).toBe('#ffff00')
    expect(r2.cells[1]!.props.shading).toBeUndefined()
    // Margins: the default table style's, overridden per cell.
    expect(r1.cells[1]!.margins).toEqual({ startPt: 5.4, endPt: 5.4 })
    expect(r1.cells[2]!.margins).toEqual({ startPt: 0, endPt: 5.4 })
    // Borders: outer top on the first row, inside lines between, the cell's own bottom.
    expect(t.rows[0]!.cells[0]!.borders.top).toMatchObject({ style: 'single', widthPt: 1, color: '#000000' })
    expect(r1.cells[1]!.borders).toMatchObject({ top: { widthPt: 0.5, color: '#999999' }, start: { style: 'dashed' } })
    expect(r2.cells[2]!.borders.bottom).toMatchObject({ style: 'double', widthPt: 1.5, color: '#ff0000' })
  })
})

describe('docx model: images, links, bookmarks, fields, notes', () => {
  it('reads inline pictures with their media part, size and alt text; anchored ones are marked floating', () => {
    const doc = parseDocx(
      buildDocx({
        media: { rIdImg: { name: 'logo.png', bytes: PNG_1PX } },
        body:
          p(inlineImage('rIdImg', 914400, 457200, 'Company logo', 'Logo')) +
          p(inlineImage('rIdImg', 1270000, 1270000).replace(/wp:inline/g, 'wp:anchor')) +
          p(inlineImage('rIdMissing', 12700, 12700)) +
          sectPr(),
      }),
    )
    const [a, b, c] = paras(doc.sections[0]!.blocks).map((x) => x.inlines[0]!)
    expect(a).toMatchObject({ type: 'image', part: '/word/media/logo.png', contentType: 'image/png', widthPt: 72, heightPt: 36, alt: 'Company logo', title: 'Logo', floating: false })
    expect(b).toMatchObject({ type: 'image', floating: true, widthPt: 100 })
    expect(c).toMatchObject({ type: 'image', part: null })
  })

  it('shows charts, diagrams and shapes as placeholders, keeping a text box text', () => {
    const graphic = (uri: string, inner = '') =>
      `<w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><wp:docPr id="2" name="x"/><a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    const doc = parseDocx(
      buildDocx({
        body:
          p(graphic('http://schemas.openxmlformats.org/drawingml/2006/chart', '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/>')) +
          p(graphic('http://schemas.microsoft.com/office/word/2010/wordprocessingShape', `<wps:wsp><wps:txbx><w:txbxContent>${p(r('Inside the box'))}</w:txbxContent></wps:txbx></wps:wsp>`)) +
          p('<w:r><w:pict><v:shape style="width:100pt;height:50pt"><v:textbox><w:txbxContent>' + p(r('VML box')) + '</w:txbxContent></v:textbox></v:shape></w:pict></w:r>') +
          p('<m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath>') +
          sectPr(),
      }),
    )
    const [chart, shape, vml, eq] = paras(doc.sections[0]!.blocks).map((x) => x.inlines[0]!)
    expect(chart).toMatchObject({ type: 'placeholder', what: 'chart', label: 'Chart not shown yet', widthPt: 100, heightPt: 50 })
    expect(shape).toMatchObject({ type: 'placeholder', what: 'shape', label: 'Shape shown as its text' })
    expect(paras((shape as { blocks: Block[] }).blocks).map(paragraphText)).toEqual(['Inside the box'])
    expect(vml).toMatchObject({ what: 'shape', widthPt: 100, heightPt: 50 })
    expect(eq).toMatchObject({ what: 'equation', text: 'x=1' })
  })

  it('takes the Fallback of mc:AlternateContent when the Choice needs what we do not understand', () => {
    const para = firstPara(
      buildDocx({
        body:
          p(
            `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:t>new</w:t></mc:Choice><mc:Fallback><w:t>old</w:t></mc:Fallback></mc:AlternateContent></w:r>`,
          ) + sectPr(),
      }),
    )
    expect(paragraphText(para)).toBe('old')
  })

  it('reads external and internal hyperlinks and bookmarks', () => {
    const para = firstPara(
      buildDocx({
        links: { rIdL: 'https://example.com/x' },
        body: p(`<w:bookmarkStart w:id="0" w:name="intro"/>${r('Intro')}<w:bookmarkEnd w:id="0"/><w:hyperlink r:id="rIdL" w:tooltip="Go">${r('site')}</w:hyperlink><w:hyperlink w:anchor="intro">${r('back')}</w:hyperlink>`) + sectPr(),
      }),
    )
    expect(para.inlines.map((i) => i.type)).toEqual(['bookmark', 'text', 'link', 'link'])
    expect(para.inlines[0]).toMatchObject({ name: 'intro' })
    expect(para.inlines[2]).toMatchObject({ href: 'https://example.com/x', anchor: null, tooltip: 'Go' })
    expect(para.inlines[3]).toMatchObject({ href: null, anchor: 'intro' })
  })

  it('keeps fields with their cached result: complex (fldChar), simple, and fields spanning paragraphs', () => {
    const fld = (instr: string, result: string) =>
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
    const doc = parseDocx(
      buildDocx({
        body:
          p(r('Page ') + fld(' PAGE \\* MERGEFORMAT ', '3') + ' ' + `<w:fldSimple w:instr=" NUMPAGES ">${r('9')}</w:fldSimple>`) +
          p(fld(' HYPERLINK "https://example.com" \\o "tip" ', 'link text')) +
          p(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('Entry one')}`) +
          p(`${r('Entry two')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`) +
          sectPr(),
      }),
    )
    const [a, b, c, d] = paras(doc.sections[0]!.blocks)
    expect(paragraphText(a!)).toBe('Page 39')
    expect(a!.inlines[1]).toMatchObject({ type: 'field', code: 'PAGE', switches: { '*': 'MERGEFORMAT' } })
    expect(a!.inlines[2]).toMatchObject({ type: 'field', code: 'NUMPAGES' })
    expect(b!.inlines[0]).toMatchObject({ type: 'field', code: 'HYPERLINK', args: ['https://example.com'], switches: { o: 'tip' } })
    expect(paragraphText(c!)).toBe('Entry one')
    expect(paragraphText(d!)).toBe('Entry two')
    expect(c!.inlines[0]).toMatchObject({ type: 'field', code: 'TOC' })
  })

  it('parses field instructions', () => {
    expect(parseFieldInstruction(' HYPERLINK \\l "sec_2" ')).toEqual({ code: 'HYPERLINK', args: [], switches: { l: 'sec_2' } })
    expect(parseFieldInstruction('page')).toEqual({ code: 'PAGE', args: [], switches: {} })
  })

  it('numbers footnotes in reference order and reads their text; separators are skipped', () => {
    const doc = parseDocx(
      buildDocx({
        footnotes:
          '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
          `<w:footnote w:id="7"><w:p><w:r><w:footnoteRef/></w:r>${r(' Second note')}</w:p></w:footnote>` +
          `<w:footnote w:id="3"><w:p><w:r><w:footnoteRef/></w:r>${r(' First note')}</w:p></w:footnote>`,
        body: p(r('a') + '<w:r><w:footnoteReference w:id="3"/></w:r>' + r('b') + '<w:r><w:footnoteReference w:id="7"/></w:r>') + sectPr(),
      }),
    )
    expect(paragraphText(paras(doc.sections[0]!.blocks)[0]!)).toBe('a1b2')
    expect(doc.footnotes.map((n) => [n.id, n.mark, paragraphText(paras(n.blocks)[0]!)])).toEqual([
      ['3', '1', '1 First note'],
      ['7', '2', '2 Second note'],
    ])
  })

  it('reads tracked changes (author, date, moves) and comments with their anchors and threads', () => {
    const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
    const doc = parseDocx(
      buildDocx({
        comments: `<w:comment w:id="0" w:author="Ann Lee" w:date="2026-11-20T09:00:00Z"><w:p w14:paraId="0000000A" ${W14}>${r('Why?')}</w:p></w:comment>`,
        settings: '<w:trackRevisions/>',
        body:
          p(
            `<w:ins w:id="1" w:author="A" w:date="2026-11-01T00:00:00Z">${r('new')}</w:ins><w:del w:id="2" w:author="B"><w:r><w:delText>old</w:delText></w:r></w:del>` +
              `<w:commentRangeStart w:id="0"/><w:moveTo w:id="3" w:author="C">${r('moved')}</w:moveTo><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>`,
          ) + sectPr(),
      }),
    )
    const para = paras(doc.sections[0]!.blocks)[0]!
    const changes = para.inlines.filter((i) => i.type === 'change')
    expect(changes.map((c) => [c.kind, c.move, c.id, c.author, c.date])).toEqual([
      ['insert', false, '1', 'A', '2026-11-01T00:00:00Z'],
      ['delete', false, '2', 'B', null],
      ['insert', true, '3', 'C', null],
    ])
    expect(paragraphText(para)).toBe('newmoved')
    expect(doc.hasChanges).toBe(true)
    expect(doc.settings.trackRevisions).toBe(true)
    expect(doc.comments).toEqual([
      { id: '0', author: 'Ann Lee', initials: 'AL', date: '2026-11-20T09:00:00Z', text: 'Why?', parentId: null, done: false, paraId: '0000000A', durableId: null },
    ])
    const moved = changes[2]!.children[0]!
    expect(moved.type === 'text' && doc.commentAnchors.get(moved.source)).toEqual(['0'])
    // Both are shown now: no "not shown" notice.
    expect(doc.notices).toEqual([])
  })

  it('shows unknown content as a visible placeholder rather than dropping it', () => {
    const doc = parseDocx(buildDocx({ body: p(r('a') + '<w:futureThing/>') + '<w:altChunk r:id="rId99"/>' + sectPr() }))
    const [para, chunk] = doc.sections[0]!.blocks
    expect((para as Paragraph).inlines[1]).toMatchObject({ type: 'placeholder', label: 'Unsupported content (w:futureThing) not shown' })
    expect(chunk).toMatchObject({ type: 'placeholder', label: 'Imported content (altChunk) not shown yet' })
  })
})

describe('docx model: broken files fail loud', () => {
  it('rejects what is not a Word package, with the reason', () => {
    expect(() => parseDocx(strToU8('%PDF-1.7'))).toThrow(DocxError)
    expect(() => parseDocx(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/Content_Types/)
    const noDoc = buildDocx({ body: '' })
    expect(() => parseDocx(noDoc)).not.toThrow()
    const broken = zipSync({
      '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'),
      '_rels/.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'),
    })
    expect(() => parseDocx(broken)).toThrow(/Could not read \/word\/document\.xml: .*unclosed/)
  })
})
