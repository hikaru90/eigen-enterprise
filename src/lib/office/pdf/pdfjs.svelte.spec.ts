import { describe, expect, it } from 'vitest'
import { makePdf } from './fixtures'
import { openPdf, pdfAssetUrl } from './pdfjs'

describe('pdf.js in the browser', () => {
  it('parses in its worker and draws a page in its renderer worker', async () => {
    const task = await openPdf(await makePdf([{ lines: ['Hello from the worker'] }]), () => {
      throw new Error('no password expected')
    })
    const doc = await task.promise
    expect(doc.numPages).toBe(1)
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    document.body.append(canvas)
    const render = page.render({ canvas, viewport })
    await render.promise
    expect(render.isWorkerRendering).toBe(true)
    const text = await page.getTextContent()
    expect(text.items.map((i) => ('str' in i ? i.str : '')).join('')).toContain(
      'Hello from the worker',
    )
    canvas.remove()
    await task.destroy()
  })

  it('serves its data files (fonts, CMaps, decoders) from the bundle', async () => {
    for (const [kind, file] of [
      ['standardFontDataUrl', 'FoxitSymbol.pfb'],
      ['cMapUrl', 'UniJIS-UCS2-H.bcmap'],
      ['wasmUrl', 'openjpeg.wasm'],
    ] as const) {
      const res = await fetch(pdfAssetUrl(kind, file))
      expect(res.ok, file).toBe(true)
      expect((await res.arrayBuffer()).byteLength, file).toBeGreaterThan(100)
    }
    expect(() => pdfAssetUrl('wasmUrl', 'nope.wasm')).toThrow('wasm/nope.wasm')
  })
})
