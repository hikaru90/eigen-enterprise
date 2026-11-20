import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { DocxError } from './model'
import { buildDocx, inlineImage, p, PNG_1PX, r, sectPr } from './test-utils/builder'
import { extractText } from './text'

const STYLES = `
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="H2"><w:name w:val="heading 2"/><w:basedOn w:val="H1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="NamedLikeHeading"><w:name w:val="heading 3"/></w:style>`

const NUMBERING = `
<w:abstractNum w:abstractNumId="0">
  <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>
  <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1">
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
  <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%2)"/></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`

const li = (text: string, numId: string, ilvl = 0) => p(r(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`)
const cell = (inner: string, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${inner}</w:tc>`

describe('docx extractText (Markdown for agents)', () => {
  it('turns outline levels into headings — never style names — and keeps paragraphs apart', async () => {
    const md = await extractText(
      buildDocx({
        styles: STYLES,
        body:
          p(r('Annual report'), '<w:pStyle w:val="H1"/>') +
          p(r('Intro text.')) +
          p(r('Details'), '<w:pStyle w:val="H2"/>') +
          p(r('Direct level'), '<w:outlineLvl w:val="2"/>') +
          p(r('Not a heading'), '<w:pStyle w:val="NamedLikeHeading"/>') +
          p('') +
          sectPr(),
      }),
    )
    expect(md).toBe('# Annual report\n\nIntro text.\n\n## Details\n\n### Direct level\n\nNot a heading\n')
  })

  it('writes lists with nesting, bullets as "-", decimal numbers as "n.", other labels kept', async () => {
    const md = await extractText(
      buildDocx({
        numbering: NUMBERING,
        body: li('Apples', '1') + li('Green', '1', 1) + li('Pears', '1') + p(r('Between.')) + li('First', '2') + li('Sub', '2', 1) + li('Second', '2') + sectPr(),
      }),
    )
    expect(md).toBe('- Apples\n  - Green\n- Pears\n\nBetween.\n\n1. First\n   - (a) Sub\n2. Second\n')
  })

  it('writes tables as Markdown tables, with spans and merges as empty cells', async () => {
    const md = await extractText(
      buildDocx({
        body:
          `<w:tbl><w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/></w:tblGrid>` +
          `<w:tr>${cell(p(r('Name')))}${cell(p(r('Role | team')))}${cell(p(r('Since')))}</w:tr>` +
          `<w:tr>${cell(p(r('Ada')), '<w:vMerge w:val="restart"/>')}${cell(p(r('Eng')) + p(r('Lead')))}${cell(p(r('2019')))}</w:tr>` +
          `<w:tr>${cell(p(''), '<w:vMerge/>')}${cell(p(r('Both')), '<w:gridSpan w:val="2"/>')}</w:tr>` +
          `</w:tbl>` +
          sectPr(),
      }),
    )
    expect(md).toBe('| Name | Role \\| team | Since |\n| --- | --- | --- |\n| Ada | Eng<br>Lead | 2019 |\n|  | Both |  |\n')
  })

  it('writes images as ![alt](image), links as Markdown links, and appends footnotes', async () => {
    const md = await extractText(
      buildDocx({
        media: { rIdImg: { name: 'a.png', bytes: PNG_1PX } },
        links: { rIdL: 'https://example.com' },
        footnotes: `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${r(' Source: survey.')}</w:p></w:footnote>`,
        body:
          p(inlineImage('rIdImg', 12700, 12700, 'Revenue chart')) +
          p(inlineImage('rIdImg', 12700, 12700)) +
          p(r('See ') + `<w:hyperlink r:id="rIdL">${r('our site')}</w:hyperlink>` + r(' for more') + '<w:r><w:footnoteReference w:id="1"/></w:r>' + r('.')) +
          sectPr(),
      }),
    )
    expect(md).toBe('![Revenue chart](image)\n\n![](image)\n\nSee [our site](https://example.com) for more[^1].\n\n[^1]: Source: survey.\n')
  })

  it('leaves out headers, footers, hidden and deleted text; keeps inserted text and field results', async () => {
    const md = await extractText(
      buildDocx({
        headers: { rIdH: p(r('HEADER TEXT')) },
        footers: { rIdF: p(r('FOOTER TEXT')) },
        body:
          p(r('Visible') + r(' secret', '<w:vanish/>') + `<w:del w:author="a"><w:r><w:delText> gone</w:delText></w:r></w:del><w:ins w:author="a">${r(' added')}</w:ins>`) +
          p(`<w:fldSimple w:instr=" DATE ">${r('20 Nov 2026')}</w:fldSimple>`) +
          sectPr('<w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/>'),
      }),
    )
    expect(md).toBe('Visible added\n\n20 Nov 2026\n')
  })

  it('says what it could not extract instead of dropping it, and keeps text box text', async () => {
    const md = await extractText(
      buildDocx({
        body:
          p(
            `<w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="1" name="c"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></wp:inline></w:drawing></w:r>`,
          ) +
          p(`<w:r><w:pict><v:shape style="width:10pt;height:10pt"><v:textbox><w:txbxContent>${p(r('Boxed'))}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`) +
          sectPr(),
      }),
    )
    expect(md).toBe('[Chart not shown yet]\n\nBoxed\n')
  })

  it('escapes paragraph text that Markdown would read as structure', async () => {
    const md = await extractText(buildDocx({ body: p(r('# not a heading')) + p(r('1. not a list')) + sectPr() }))
    expect(md).toBe('\\# not a heading\n\n1\\. not a list\n')
  })

  it('fails loud on a broken file', async () => {
    await expect(extractText(strToU8('not a zip'))).rejects.toThrow(DocxError)
  })
})
