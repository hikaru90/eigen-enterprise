import type { SheetEditor } from './editor'
import {
  requireBrowserExecutable,
  type BrowserProbe,
} from '../../../../modules/brand/extract/capture'
import { BrowserUnavailableError } from '../../../../modules/brand/extract/capture-errors'
import { renderWorkbookHtml, type RenderHtmlOptions } from './print'

/** The browser capability's own error, re-exported so module code and specs need no cross-module import. */
export { BrowserUnavailableError }

/**
 * Workbook → PDF export via the server's headless Chromium capability
 * (EE_CAP_CHROMIUM, same path as `brand.material_export`). Fails loud with
 * `PdfBrowserUnavailableError` when Chromium is not installed.
 */

export const SHEET_BROWSER_UNAVAILABLE =
  'Exporting a spreadsheet to PDF needs a browser on the server, and this install doesn’t have one.'

const RENDER_TIMEOUT_MS = 30_000

export class PdfBrowserUnavailableError extends Error {
  readonly code = 'browser_unavailable' as const
  constructor(cause?: unknown) {
    super(SHEET_BROWSER_UNAVAILABLE, { cause })
    this.name = 'PdfBrowserUnavailableError'
  }
}

export type PdfPage = {
  route(
    pattern: string,
    handler: (route: {
      request(): { url(): string }
      abort(): Promise<void>
      continue(): Promise<void>
    }) => Promise<void>,
  ): Promise<void>
  setContent(html: string, options: { waitUntil: 'load'; timeout: number }): Promise<void>
  pdf(options: { printBackground: boolean; preferCSSPageSize: boolean }): Promise<Buffer>
}

export type PdfBrowser = {
  newPage(): Promise<PdfPage>
  close(): Promise<void>
}

export type PdfBrowserLauncher = (executablePath: string) => Promise<PdfBrowser>

const playwrightLauncher: PdfBrowserLauncher = async (executablePath) => {
  const { chromium } = await import('playwright')
  return (await chromium.launch({ headless: true, executablePath })) as unknown as PdfBrowser
}

export type ExportPdfDeps = {
  browser?: BrowserProbe
  launch?: PdfBrowserLauncher
}

export type ExportedSheetPdf = {
  filename: string
  mime: 'application/pdf'
  sizeBytes: number
  bytes: Uint8Array
  sheets: string[]
}

export function pdfFilenameFor(workbookName: string): string {
  const stem =
    workbookName
      .replace(/\.xlsx?$/i, '')
      .replace(/\.xlsm$/i, '')
      .trim() || 'workbook'
  return `${stem}.pdf`
}

export async function exportWorkbookPdf(
  ed: SheetEditor,
  workbookName: string,
  opts: RenderHtmlOptions = {},
  deps: ExportPdfDeps = {},
): Promise<ExportedSheetPdf> {
  let executablePath: string
  try {
    executablePath = await requireBrowserExecutable(deps.browser)
  } catch (err) {
    if (err instanceof BrowserUnavailableError) throw new PdfBrowserUnavailableError(err)
    throw err
  }
  const rendered = renderWorkbookHtml(ed, opts)
  const browser = await (deps.launch ?? playwrightLauncher)(executablePath)
  try {
    const page = await browser.newPage()
    // Block all external network requests: spreadsheet PDF HTML is 100% self-contained.
    await page.route('**/*', async (route) => {
      const url = route.request().url()
      if (url.startsWith('data:') || url === 'about:blank') await route.continue()
      else await route.abort()
    })
    await page.setContent(rendered.html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS })
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
    const bytes = new Uint8Array(pdf)
    return {
      filename: pdfFilenameFor(workbookName),
      mime: 'application/pdf',
      sizeBytes: bytes.byteLength,
      bytes,
      sheets: rendered.sheets,
    }
  } finally {
    await browser.close()
  }
}
