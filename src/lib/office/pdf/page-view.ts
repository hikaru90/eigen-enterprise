/**
 * One page on screen: its canvas (drawn by pdf.js, in its renderer worker)
 * and its text layer (transparent spans over the canvas, one per text item,
 * in content order — so a selection copies in reading order). The viewer
 * creates a PageView when the page comes near the viewport and destroys it
 * when the page scrolls far away; the page's slot keeps its size either way.
 *
 * The text layer is laid out for 100% and follows the zoom through the CSS
 * variable `--total-scale-factor` on the page slot, so zooming only redraws
 * the canvas.
 */
import type { PdfJs, PdfPage } from './pdfjs'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import { canvasPixelRatio, CSS_PER_POINT } from './layout'

export type Highlight = { item: number; from: number; to: number; selected: boolean }

export class PageView {
  #lib: PdfJs
  #page: PdfPage
  #host: HTMLElement
  #canvas: HTMLCanvasElement | null = null
  #drawnAt = 0
  #task: ReturnType<PdfPage['render']> | null = null
  #text: { layer: InstanceType<PdfJs['TextLayer']>; div: HTMLDivElement; ready: boolean } | null =
    null
  #highlights: Highlight[] = []
  #touched = new Set<number>()
  #destroyed = false

  constructor(lib: PdfJs, page: PdfPage, host: HTMLElement) {
    this.#lib = lib
    this.#page = page
    this.#host = host
  }

  /** Whether the canvas is drawn at this zoom and pixel ratio. */
  isDrawnAt(zoom: number, pixelRatio: number): boolean {
    return this.#drawnAt === zoom * pixelRatio
  }

  /** Draws the canvas at `zoom`; the old canvas stays (stretched) until the new one is ready. */
  async draw(zoom: number, devicePixelRatio: number): Promise<void> {
    const at = zoom * devicePixelRatio
    if (this.#drawnAt === at) return
    this.#task?.cancel()
    const viewport = this.#page.getViewport({ scale: zoom * CSS_PER_POINT })
    const ratio = canvasPixelRatio(viewport.width, viewport.height, devicePixelRatio)
    const canvas = document.createElement('canvas')
    canvas.className = 'pdf-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    const task = this.#page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    })
    this.#task = task
    try {
      await task.promise
    } catch (err) {
      if (err instanceof this.#lib.RenderingCancelledException) return
      throw err
    } finally {
      if (this.#task === task) this.#task = null
    }
    if (this.#destroyed) return
    this.#canvas?.remove()
    this.#host.prepend(canvas)
    this.#canvas = canvas
    this.#drawnAt = at
    this.#host.dataset.drawn = 'true'
  }

  /** Lays out the text layer once (from the page's text content, shared with find). */
  async showText(content: TextContent): Promise<void> {
    if (this.#text || this.#destroyed) return
    const div = document.createElement('div')
    div.className = 'textLayer'
    const layer = new this.#lib.TextLayer({
      textContentSource: content,
      container: div,
      viewport: this.#page.getViewport({ scale: CSS_PER_POINT }),
    })
    this.#text = { layer, div, ready: false }
    this.#host.append(div)
    try {
      await layer.render()
    } catch (err) {
      if (err instanceof this.#lib.AbortException) return
      throw err
    }
    if (this.#destroyed) return
    const end = document.createElement('div')
    end.className = 'endOfContent'
    div.append(end)
    this.#text.ready = true
    this.#paint()
  }

  /** The text items' spans (index = text item, as in ./find.ts). */
  textSpans(): HTMLElement[] {
    return this.#text?.ready ? this.#text.layer.textDivs : []
  }

  setHighlights(highlights: Highlight[]): void {
    this.#highlights = highlights
    this.#paint()
  }

  #paint() {
    if (!this.#text?.ready) return
    const divs = this.#text.layer.textDivs
    const strs = this.#text.layer.textContentItemsStr
    for (const i of this.#touched) {
      const div = divs[i]
      if (div) div.textContent = strs[i] ?? ''
    }
    this.#touched.clear()
    const byItem = new Map<number, Highlight[]>()
    for (const h of this.#highlights) byItem.set(h.item, [...(byItem.get(h.item) ?? []), h])
    for (const [i, list] of byItem) {
      const div = divs[i]
      const str = strs[i]
      if (!div || str === undefined) continue
      list.sort((a, b) => a.from - b.from)
      div.textContent = ''
      let at = 0
      for (const h of list) {
        if (h.from > at) div.append(str.slice(at, h.from))
        const mark = document.createElement('span')
        mark.className = h.selected ? 'highlight selected' : 'highlight'
        mark.textContent = str.slice(h.from, h.to)
        div.append(mark)
        at = h.to
      }
      if (at < str.length) div.append(str.slice(at))
      this.#touched.add(i)
    }
  }

  destroy(): void {
    this.#destroyed = true
    this.#task?.cancel()
    this.#text?.layer.cancel()
    this.#canvas?.remove()
    this.#text?.div.remove()
    delete this.#host.dataset.drawn
    this.#page.cleanup()
  }
}

/** Draws a page's thumbnail `width` CSS pixels wide into a new canvas. */
export async function drawThumbnail(
  page: PdfPage,
  width: number,
  devicePixelRatio: number,
): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: (width / base.width) * devicePixelRatio })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.setAttribute('aria-hidden', 'true')
  await page.render({ canvas, viewport }).promise
  return canvas
}
