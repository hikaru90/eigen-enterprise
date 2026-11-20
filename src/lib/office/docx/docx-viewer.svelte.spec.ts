import { strToU8 } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import DocxViewer from './docx-viewer.svelte'
import { buildDocx, inlineImage, p, PNG_1PX, r, sectPr } from './test-utils/builder'

const { readBytes } = vi.hoisted(() => ({ readBytes: vi.fn<(id: string) => Promise<Uint8Array>>() }))
vi.mock('$lib/drive/api', () => ({ driveApi: { readBytes } }))

const props = { fileId: 'f1', name: 'report.docx', canEdit: false, heartbeatMs: 10_000 }
const A4 = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>'
const LOREM =
  'The quarterly review covers revenue, hiring, product milestones and the risks we see for the coming months across every team in the company. '

const pages = () => [...document.querySelectorAll<HTMLElement>('[data-testid="docx-page"]')]
async function laidOut(min = 1) {
  await expect.element(page.getByTestId('docx-page-indicator')).toHaveTextContent(/Page \d+ of \d+/)
  expect(pages().length).toBeGreaterThanOrEqual(min)
  return pages()
}
const bodyText = (el: HTMLElement) => el.querySelector('.docx-body')?.textContent ?? ''

describe('DocxViewer', () => {
  beforeEach(() => {
    readBytes.mockReset()
  })

  it('renders a page at its true size with its margins', async () => {
    readBytes.mockResolvedValue(buildDocx({ body: p(r('Hello Word')) + sectPr(A4) }))
    render(DocxViewer, props)
    const [first] = await laidOut()
    expect(readBytes).toHaveBeenCalledWith('f1')
    // A4 in twips → points → CSS pixels, unscaled layout size.
    expect(first!.offsetWidth).toBeCloseTo((11906 / 20) * (96 / 72), 0)
    expect(first!.offsetHeight).toBeCloseTo((16838 / 20) * (96 / 72), 0)
    const body = first!.querySelector<HTMLElement>('.docx-body')!
    expect(body.offsetTop).toBeCloseTo(96, 0)
    expect(body.offsetLeft).toBeCloseTo(96, 0)
    expect(bodyText(first!)).toContain('Hello Word')
  })

  it('flows content onto further pages, with the header and footer (and page numbers) on every page', async () => {
    const fld = (code: string) =>
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ${code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('1')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
    const body = Array.from({ length: 60 }, (_, i) => p(r(`[${i + 1}] ${LOREM}`))).join('')
    readBytes.mockResolvedValue(
      buildDocx({
        headers: { rIdH: p(r('Kindred report')) },
        footers: { rIdF: p(r('Page ') + fld('PAGE') + r(' of ') + fld('NUMPAGES')) },
        body: body + sectPr(`<w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/>${A4}`),
      }),
    )
    render(DocxViewer, props)
    const all = await laidOut(2)
    const n = all.length
    all.forEach((pg, i) => {
      expect(pg.querySelector('[data-testid="docx-header"]')?.textContent).toBe('Kindred report')
      expect(pg.querySelector('[data-testid="docx-footer"]')?.textContent).toBe(`Page ${i + 1} of ${n}`)
    })
    // Nothing lost or doubled across the page breaks.
    const text = all.map(bodyText).join('')
    for (let i = 1; i <= 60; i++) expect(text.split(`[${i}] The quarterly`).length - 1).toBe(1)
    // Each page's content stays inside its body area.
    for (const pg of all) {
      const bodyEl = pg.querySelector<HTMLElement>('.docx-body')!
      const flow = bodyEl.querySelector<HTMLElement>('.docx-body-flow')!
      const last = flow.lastElementChild as HTMLElement
      expect(last.offsetTop + last.offsetHeight).toBeLessThanOrEqual(bodyEl.offsetHeight + 1)
    }
    await expect.element(page.getByTestId('docx-page-indicator')).toHaveTextContent(`Page 1 of ${n}`)
  })

  it('splits a long paragraph at a line boundary across pages', async () => {
    readBytes.mockResolvedValue(buildDocx({ body: p(r(LOREM.repeat(60).trim())) + sectPr(A4) }))
    render(DocxViewer, props)
    const all = await laidOut(2)
    const parts = all.map((pg) => pg.querySelector('.docx-p')!)
    expect(parts.map((x) => x.textContent).join('')).toBe(LOREM.repeat(60).trim())
    // The continuation starts a new line: no first-line indent, no space before.
    expect((parts[1] as HTMLElement).style.marginTop).toBe('0px')
  })

  it('keeps a heading with the paragraph after it (w:keepNext) and an unsplittable paragraph whole (w:keepLines)', async () => {
    // A4 with 1" margins leaves 697.9pt; 34 lines of exactly 20pt fill 680pt, the 15pt heading still fits after them.
    const exact = (pt: number) => `<w:spacing w:before="0" w:after="0" w:line="${pt * 20}" w:lineRule="exact"/>`
    const filler = Array.from({ length: 34 }, (_, i) => p(r(`Filler ${i + 1}`), exact(20))).join('')
    const heading = p(r('Results'), `<w:keepNext/><w:outlineLvl w:val="0"/>${exact(15)}`)
    const kept = p(r('Line one') + '<w:r><w:br/></w:r>' + r('Line two') + '<w:r><w:br/></w:r>' + r('Line three'), `<w:keepLines/>${exact(20)}`)
    readBytes.mockResolvedValue(buildDocx({ body: filler + heading + kept + sectPr(A4) }))
    render(DocxViewer, props)
    const all = await laidOut(2)
    expect(all[0]!.querySelectorAll('.docx-p')).toHaveLength(34)
    const second = [...all[1]!.querySelectorAll('.docx-p')].map((x) => x.textContent)
    expect(second).toEqual(['Results', 'Line oneLine twoLine three'])
    expect(all[1]!.querySelector('[role="heading"]')?.getAttribute('aria-level')).toBe('1')
  })

  it('splits a table at a row boundary and repeats its header row', async () => {
    const row = (a: string, header = false) =>
      `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}<w:tc>${p(r(a))}</w:tc><w:tc>${p(r(`${a} detail`))}</w:tc></w:tr>`
    readBytes.mockResolvedValue(
      buildDocx({
        body:
          `<w:tbl><w:tblPr><w:tblBorders><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="5000"/></w:tblGrid>${row('Item', true)}${Array.from({ length: 70 }, (_, i) => row(`Row ${i + 1}`)).join('')}</w:tbl>` +
          sectPr(A4),
      }),
    )
    render(DocxViewer, props)
    const all = await laidOut(2)
    const second = all[1]!.querySelector('table')!
    expect(second.querySelector('tr')!.textContent).toBe('ItemItem detail')
    const rows = all.flatMap((pg) => [...pg.querySelectorAll('tr:not([data-repeated])')].map((tr) => tr.textContent))
    expect(rows).toHaveLength(71)
    expect(new Set(rows).size).toBe(71)
  })

  it('shows inline pictures from the package with their alt text; floating ones carry a visible note', async () => {
    readBytes.mockResolvedValue(
      buildDocx({
        media: { rIdImg: { name: 'logo.png', bytes: PNG_1PX } },
        body: p(inlineImage('rIdImg', 914400, 457200, 'Company logo')) + p(inlineImage('rIdImg', 914400, 914400, 'Map').replace(/wp:inline/g, 'wp:anchor')) + sectPr(A4),
      }),
    )
    render(DocxViewer, props)
    await laidOut()
    const img = page.getByAltText('Company logo')
    await expect.element(img).toBeVisible()
    const el = img.element() as HTMLImageElement
    expect(el.src).toMatch(/^blob:/)
    expect(el.offsetWidth).toBeCloseTo(96, 0)
    expect(el.offsetHeight).toBeCloseTo(48, 0)
    await expect.element(page.getByText('Floating picture shown in line')).toBeVisible()
  })

  it('shows what it does not render yet as a visible placeholder', async () => {
    readBytes.mockResolvedValue(
      buildDocx({
        body:
          p(
            `<w:r><w:drawing><wp:inline><wp:extent cx="2540000" cy="1270000"/><wp:docPr id="1" name="c"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></wp:inline></w:drawing></w:r>`,
          ) + sectPr(`${A4}<w:cols w:num="2" w:space="720"/>`),
      }),
    )
    render(DocxViewer, props)
    await laidOut()
    await expect.element(page.getByText('Chart not shown yet')).toBeVisible()
    await expect.element(page.getByText('This section has 2 columns; shown as one column.')).toBeVisible()
  })

  it('lays out right-to-left paragraphs and CJK text', async () => {
    readBytes.mockResolvedValue(
      buildDocx({
        body: p(r('مرحبا بالعالم', '<w:rtl/>'), '<w:bidi/><w:jc w:val="left"/>') + p(r('日本語のテキスト', '<w:rFonts w:eastAsia="MS Mincho"/><w:lang w:eastAsia="ja-JP"/>')) + sectPr(A4),
      }),
    )
    render(DocxViewer, props)
    const [first] = await laidOut()
    const [rtl, cjk] = [...first!.querySelectorAll<HTMLElement>('.docx-p')]
    expect(getComputedStyle(rtl!).direction).toBe('rtl')
    expect(rtl!.textContent).toBe('مرحبا بالعالم')
    expect(cjk!.textContent).toBe('日本語のテキスト')
    expect(cjk!.querySelector('span')!.style.fontFamily).toContain('MS Mincho')
  })

  it('keeps the text selectable and zooms between fit width and 100%', async () => {
    readBytes.mockResolvedValue(buildDocx({ body: p(r('Select me')) + sectPr(A4) }))
    render(DocxViewer, props)
    const [first] = await laidOut()
    expect(getComputedStyle(first!).userSelect).not.toBe('none')
    await userEvent.click(page.getByTestId('docx-zoom-actual'))
    await expect.element(page.getByTestId('docx-zoom')).toHaveTextContent('100%')
    expect(first!.getBoundingClientRect().width).toBeCloseTo(first!.offsetWidth, 0)
    await userEvent.click(page.getByRole('button', { name: 'Zoom out' }))
    await expect.element(page.getByTestId('docx-zoom')).toHaveTextContent('90%')
    await userEvent.click(page.getByTestId('docx-zoom-fit'))
    await expect.element(page.getByTestId('docx-zoom-fit')).toHaveAttribute('aria-pressed', 'true')
  })

  it('says clearly when the file is broken', async () => {
    readBytes.mockResolvedValue(strToU8('this is not a docx'))
    render(DocxViewer, props)
    await expect.element(page.getByRole('alert')).toHaveTextContent(/This Word document could not be opened: Not a ZIP package/)
  })

  it('says clearly when the file cannot be loaded', async () => {
    readBytes.mockRejectedValue(new Error('Loading the file failed (500).'))
    render(DocxViewer, props)
    await expect.element(page.getByRole('alert')).toHaveTextContent('This Word document could not be opened: Loading the file failed (500).')
  })
})
