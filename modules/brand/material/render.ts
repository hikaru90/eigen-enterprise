import sharp from 'sharp'
import { requireBrowserExecutable, type BrowserProbe } from '../extract/capture'
import { BrowserUnavailableError } from '../extract/capture-errors'
import { MERCH_EXPORT_DPI, exportOf, type MaterialFormat } from './formats'
import { MaterialError } from './types'

/**
 * The material page (document.ts) through the server's headless browser — the
 * same chrome-headless-shell the website capture uses (ee's chromium
 * capability, EE_CAP_CHROMIUM): paper formats printed to a PDF at their exact
 * page size, the social header and merch shot as a PNG at their pixel / 300
 * dpi size. The page may load only the style's web fonts (Google Fonts) and
 * its own inline data; every other request is refused. A style font that
 * did not load fails the export loud rather than printing in a stand-in face.
 */

export const MATERIAL_BROWSER_UNAVAILABLE =
  'Exporting brand material needs a browser on the server, and this install doesn’t have one.'

const RENDER_TIMEOUT_MS = 30_000
const CSS_PX_PER_MM = 96 / 25.4
const ALLOWED_ORIGINS = ['https://fonts.googleapis.com/', 'https://fonts.gstatic.com/']

type RouteLike = { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }

export type MaterialPage = {
  route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>
  setContent(html: string, options: { waitUntil: 'networkidle'; timeout: number }): Promise<void>
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>
  pdf(options: { width: string; height: string; printBackground: boolean; preferCSSPageSize: boolean }): Promise<Buffer>
  screenshot(options: { type: 'png'; clip: { x: number; y: number; width: number; height: number } }): Promise<Buffer>
}

export type MaterialBrowser = {
  newPage(options: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<MaterialPage>
  close(): Promise<void>
}

export type MaterialBrowserLauncher = (executablePath: string) => Promise<MaterialBrowser>

const playwrightLauncher: MaterialBrowserLauncher = async (executablePath) => {
  const { chromium } = await import('playwright')
  return (await chromium.launch({ headless: true, executablePath })) as unknown as MaterialBrowser
}

export type RenderDeps = {
  browser?: BrowserProbe
  launch?: MaterialBrowserLauncher
  /** The style's web font families the page must have loaded (googleFontLinks). */
  fonts?: string[]
}

export type RenderedMaterial = { bytes: Uint8Array; mime: 'application/pdf' | 'image/png' }

async function executable(probe: BrowserProbe | undefined): Promise<string> {
  try {
    return await requireBrowserExecutable(probe)
  } catch (err) {
    if (err instanceof BrowserUnavailableError) throw new MaterialError('unavailable', MATERIAL_BROWSER_UNAVAILABLE, { cause: err })
    throw err
  }
}

/** The page's size in CSS pixels (millimetres at 96 per inch). */
function cssSize(format: MaterialFormat): { width: number; height: number } {
  const k = format.unit === 'mm' ? CSS_PX_PER_MM : 1
  return { width: format.width * k, height: format.height * k }
}

export async function renderMaterial(html: string, format: MaterialFormat, deps: RenderDeps = {}): Promise<RenderedMaterial> {
  const executablePath = await executable(deps.browser)
  const out = exportOf(format)
  const size = cssSize(format)
  const browser = await (deps.launch ?? playwrightLauncher)(executablePath)
  try {
    const page = await browser.newPage({
      viewport: { width: Math.ceil(size.width), height: Math.ceil(size.height) },
      // Merch prints at 300 dpi: CSS millimetres are 96 per inch.
      deviceScaleFactor: out.kind === 'png' && format.unit === 'mm' ? MERCH_EXPORT_DPI / 96 : 1,
    })
    await page.route('**/*', async (route) => {
      const url = route.request().url()
      if (url.startsWith('data:') || ALLOWED_ORIGINS.some((o) => url.startsWith(o))) await route.continue()
      else await route.abort()
    })
    await page.setContent(html, { waitUntil: 'networkidle', timeout: RENDER_TIMEOUT_MS })
    // Load each style face explicitly (not only what the layout happened to use): no face = it did not load.
    const missing = await page.evaluate(async (families: string[]) => {
      const out: string[] = []
      for (const family of families) {
        const faces = await document.fonts.load(`16px "${family}"`).catch(() => [])
        if (faces.length === 0) out.push(family)
      }
      return out
    }, deps.fonts ?? [])
    if (missing.length) {
      throw new MaterialError('upstream', `The style’s font ${missing.join(', ')} could not be loaded for the export. Try again in a moment.`)
    }
    if (out.kind === 'pdf') {
      const bytes = await page.pdf({ width: `${format.width}mm`, height: `${format.height}mm`, printBackground: true, preferCSSPageSize: true })
      return { bytes: new Uint8Array(bytes), mime: out.mime }
    }
    const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height } })
    const meta = await sharp(shot).metadata()
    const exact =
      meta.width === out.pixelWidth && meta.height === out.pixelHeight
        ? shot
        : await sharp(shot).resize(out.pixelWidth, out.pixelHeight, { fit: 'fill' }).png().toBuffer()
    return { bytes: new Uint8Array(exact), mime: out.mime }
  } finally {
    await browser.close()
  }
}
