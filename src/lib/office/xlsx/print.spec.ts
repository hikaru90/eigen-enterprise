import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { createSheetEditor } from './editor'
import { pageSetupOf, renderWorkbookHtml, viewOptionsOf } from './print'
import { exportWorkbookPdf, PdfBrowserUnavailableError } from './print-pdf'
import { budgetBook } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

describe('print / page setup & view options', () => {
  it('reads and writes pageSetup, printOptions, margins, Print_Area, Print_Titles and view options in schema order', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({
      op: 'set_page_setup',
      sheet: 'Budget',
      orientation: 'landscape',
      paperSize: 'letter',
      fitToWidth: 1,
      fitToHeight: 0,
      printGridlines: true,
      printHeadings: true,
      centerHorizontally: true,
      margins: { left: 0.5, right: 0.5 },
      printArea: 'A1:D4',
      repeatRows: '1:1',
    })
    ed.apply({
      op: 'set_view_options',
      sheet: 'Budget',
      showGridlines: false,
      showHeadings: false,
      zoomScale: 125,
    })

    const bytes = ed.toBytes()
    const wb = openWorkbook(bytes)
    expect(pageSetupOf(wb, 'Budget')).toEqual({
      orientation: 'landscape',
      paperSize: 'letter',
      scale: 100,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { top: 0.75, bottom: 0.75, left: 0.5, right: 0.5, header: 0.3, footer: 0.3 },
      printGridlines: true,
      printHeadings: true,
      centerHorizontally: true,
      centerVertically: false,
      printArea: 'A1:D4',
      repeatRows: '1:1',
      repeatCols: null,
    })
    expect(viewOptionsOf(wb, 'Budget')).toEqual({
      showGridlines: false,
      showHeadings: false,
      zoomScale: 125,
    })
    const xml = strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']!)
    expect(xml).toContain('fitToPage="1"')
    expect(xml).toContain('orientation="landscape"')
    expect(xml).toContain('gridLines="1"')
    expect(xml).toContain('showGridLines="0"')
    expect(xml).toContain('zoomScale="125"')
    // Clear print area and repeat rows
    ed.apply({ op: 'set_page_setup', sheet: 'Budget', printArea: null, repeatRows: null })
    expect(pageSetupOf(ed.wb, 'Budget').printArea).toBeNull()
    expect(pageSetupOf(ed.wb, 'Budget').repeatRows).toBeNull()
  })

  it('renders self-contained print HTML honoring repeatRows (<thead>), printArea, gridlines and headings', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({
      op: 'set_page_setup',
      sheet: 'Budget',
      orientation: 'landscape',
      paperSize: 'a4',
      fitToWidth: 1,
      printGridlines: true,
      printHeadings: true,
      printArea: 'A1:B4',
      repeatRows: '1:1',
    })
    const out = renderWorkbookHtml(ed, { sheet: 'Budget' })
    expect(out.orientation).toBe('landscape')
    expect(out.paperSize).toBe('a4')
    expect(out.html).toContain('@page { size: A4 landscape;')
    expect(out.html).toContain('<thead>')
    expect(out.html).toContain('Rent')
    expect(out.html).toContain('1500')
    // Column C/D outside printArea A1:B4 are excluded
    expect(out.html).not.toContain('Costs')
  })

  it('exports PDF via Chromium and fails loud when Chromium is unavailable', async () => {
    const ed = createSheetEditor(budgetBook())
    await expect(
      exportWorkbookPdf(
        ed,
        'Budget.xlsx',
        { sheet: 'Budget' },
        { browser: { executablePath: () => null, isExecutable: async () => false } },
      ),
    ).rejects.toBeInstanceOf(PdfBrowserUnavailableError)

    const routes: Array<
      (route: {
        request(): { url(): string }
        abort(): Promise<void>
        continue(): Promise<void>
      }) => Promise<void>
    > = []
    const pdfCalls: unknown[] = []
    const close = vi.fn(async () => {})
    const out = await exportWorkbookPdf(
      ed,
      'Budget.xlsx',
      { sheet: 'Budget' },
      {
        browser: { executablePath: () => '/usr/bin/chromium', isExecutable: async () => true },
        launch: async () => ({
          close,
          newPage: async () => ({
            route: async (_pattern, handler) => {
              routes.push(handler)
            },
            setContent: async () => {},
            pdf: async (opts) => {
              pdfCalls.push(opts)
              return Buffer.from('%PDF-1.4\ntest')
            },
          }),
        }),
      },
    )
    expect(out.filename).toBe('Budget.pdf')
    expect(out.mime).toBe('application/pdf')
    expect(out.sheets).toEqual(['Budget'])
    expect(pdfCalls).toEqual([{ printBackground: true, preferCSSPageSize: true }])
    expect(close).toHaveBeenCalledTimes(1)
    // Network requests other than data: and about:blank are aborted
    const abort = vi.fn(async () => {})
    const cont = vi.fn(async () => {})
    await routes[0]!({
      request: () => ({ url: () => 'https://evil.example/' }),
      abort,
      continue: cont,
    })
    expect(abort).toHaveBeenCalledTimes(1)
  })
})
