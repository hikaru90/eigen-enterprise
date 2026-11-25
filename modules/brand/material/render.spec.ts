import { PDFDocument } from 'pdf-lib'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { materialDocument } from './document'
import { exportOf, formatById } from './formats'
import { renderMaterial, type MaterialBrowserLauncher } from './render'
import { MaterialError } from './types'

const probe = (path: string | null, ok = true) => ({ executablePath: () => path, isExecutable: async () => ok })

/** A recording stand-in for the headless browser. */
function fakeLauncher(opts: { missingFonts?: string[] } = {}) {
  const calls = {
    launched: [] as string[],
    pageOptions: [] as unknown[],
    routes: [] as Array<(route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => Promise<void>>,
    content: '',
    pdf: [] as unknown[],
    screenshot: [] as unknown[],
    closed: 0,
  }
  const launch: MaterialBrowserLauncher = async (executablePath) => {
    calls.launched.push(executablePath)
    return {
      newPage: async (o) => {
        calls.pageOptions.push(o)
        return {
          route: async (_pattern, handler) => {
            calls.routes.push(handler as never)
          },
          setContent: async (html) => {
            calls.content = html
          },
          evaluate: (async () => opts.missingFonts ?? []) as never,
          pdf: async (o) => {
            calls.pdf.push(o)
            return Buffer.from('%PDF-1.7 fake')
          },
          screenshot: async (o) => {
            calls.screenshot.push(o)
            return sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer()
          },
        }
      },
      close: async () => {
        calls.closed++
      },
    }
  }
  return { launch, calls }
}

describe('renderMaterial (stand-in browser)', () => {
  it('prints a paper format to a PDF at its exact page size, backgrounds on', async () => {
    const { launch, calls } = fakeLauncher()
    const out = await renderMaterial('<html></html>', formatById('poster-a1'), { browser: probe('/opt/chrome'), launch })
    expect(calls.launched).toEqual(['/opt/chrome'])
    expect(calls.pdf).toEqual([{ width: '594mm', height: '841mm', printBackground: true, preferCSSPageSize: true }])
    expect(out.mime).toBe('application/pdf')
    expect(calls.closed).toBe(1)
  })

  it('shoots the social header as a PNG at its pixel size, merch at 300 dpi', async () => {
    const social = fakeLauncher()
    await renderMaterial('<html></html>', formatById('banner-social'), { browser: probe('/x'), launch: social.launch })
    expect(social.calls.pageOptions).toEqual([{ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 1 }])

    const merch = fakeLauncher()
    const out = await renderMaterial('<html></html>', formatById('merch-mug'), { browser: probe('/x'), launch: merch.launch })
    expect(merch.calls.pageOptions).toEqual([{ viewport: { width: 756, height: 341 }, deviceScaleFactor: 300 / 96 }])
    const meta = await sharp(Buffer.from(out.bytes)).metadata()
    // The final file is exactly the print size, whatever the browser rounded.
    expect([meta.width, meta.height]).toEqual([2362, 1063])
    expect(out.mime).toBe('image/png')
  })

  it('lets only the style’s web fonts and inline data through; every other request is refused', async () => {
    const { launch, calls } = fakeLauncher()
    await renderMaterial('<html></html>', formatById('flyer-a5'), { browser: probe('/x'), launch })
    const handler = calls.routes[0]
    const seen: string[] = []
    const route = (url: string) => ({
      request: () => ({ url: () => url }),
      abort: async () => void seen.push(`abort ${url}`),
      continue: async () => void seen.push(`go ${url}`),
    })
    for (const url of [
      'https://fonts.googleapis.com/css2?family=Inter',
      'https://fonts.gstatic.com/s/inter.woff2',
      'data:image/png;base64,AA==',
      'http://169.254.169.254/latest/meta-data',
      'https://evil.example/x.png',
    ])
      await handler(route(url))
    expect(seen).toEqual([
      'go https://fonts.googleapis.com/css2?family=Inter',
      'go https://fonts.gstatic.com/s/inter.woff2',
      'go data:image/png;base64,AA==',
      'abort http://169.254.169.254/latest/meta-data',
      'abort https://evil.example/x.png',
    ])
  })

  it('a style font that did not load fails the export loud (no silent stand-in type)', async () => {
    const { launch, calls } = fakeLauncher({ missingFonts: ['Fraunces'] })
    const err = await renderMaterial('<html></html>', formatById('flyer-a5'), { browser: probe('/x'), launch, fonts: ['Fraunces'] }).catch((e) => e)
    expect(err).toBeInstanceOf(MaterialError)
    expect(err).toMatchObject({ code: 'upstream', message: expect.stringContaining('Fraunces') })
    expect(calls.closed).toBe(1)
  })

  it('no headless browser on the server → unavailable, nothing launched', async () => {
    const launch = vi.fn()
    const err = await renderMaterial('<html></html>', formatById('flyer-a5'), { browser: probe(null), launch }).catch((e) => e)
    expect(err).toBeInstanceOf(MaterialError)
    expect(err.code).toBe('unavailable')
    expect(err.message).toBe('Exporting brand material needs a browser on the server, and this install doesn’t have one.')
    expect(launch).not.toHaveBeenCalled()
  })
})

describe('renderMaterial (real headless browser)', () => {
  const style = {
    name: 'Blueprint',
    cssVars: {
      '--background': '#ffffff',
      '--foreground': '#111111',
      '--primary': '#b00000',
      '--primary-foreground': '#ffffff',
      '--accent': '#006600',
      '--muted-foreground': '#555555',
      '--font-sans': 'sans-serif',
    },
    darkCssVars: null,
  }
  const deps = { browser: probe(chromium.executablePath()) }

  it('an A5 flyer is a one-page PDF of 148 × 210 mm', async () => {
    const format = formatById('flyer-a5')
    const html = materialDocument({ format, mode: 'light', copy: { headline: 'Hall 3', body: 'Come by.', cta: 'Find us' }, style, logo: null })
    const out = await renderMaterial(html, format, deps)
    const pdf = await PDFDocument.load(out.bytes)
    expect(pdf.getPageCount()).toBe(1)
    const { width, height } = pdf.getPage(0).getSize()
    expect(width).toBeCloseTo((148 / 25.4) * 72, 0)
    expect(height).toBeCloseTo((210 / 25.4) * 72, 0)
  }, 30_000)

  it('the social header is a 1500 × 500 PNG painted in the style', async () => {
    const format = formatById('banner-social')
    const html = materialDocument({ format, mode: 'light', copy: { headline: 'Hall 3', body: 'Come by.', cta: 'Find us' }, style, logo: null })
    const out = await renderMaterial(html, format, deps)
    expect(exportOf(format)).toMatchObject({ pixelWidth: 1500, pixelHeight: 500 })
    const img = sharp(Buffer.from(out.bytes))
    const meta = await img.metadata()
    expect([meta.width, meta.height]).toEqual([1500, 500])
    const { data } = await img.extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true })
    expect([...data.subarray(0, 3)]).toEqual([255, 255, 255])
  }, 30_000)
})
