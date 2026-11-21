/**
 * The drawing of one page in the PDF editor (./pdf-edit-page.svelte): the
 * page without its annotations (they are drawn from the staged model) into
 * a canvas placed first in `host`, and the text layer — laid out once — into
 * `textHost`, for selecting the text a markup covers. Like ./page-view.ts,
 * the DOM the component does not render lives here.
 */
import type { PdfJs, PdfPage } from './pdfjs'
import { canvasPixelRatio, CSS_PER_POINT } from './layout'

export async function drawEditPage(
  lib: PdfJs,
  page: PdfPage,
  host: HTMLElement,
  scale: number,
  devicePixelRatio: number,
): Promise<void> {
  const vp = page.getViewport({ scale })
  const ratio = canvasPixelRatio(vp.width, vp.height, devicePixelRatio)
  const canvas = document.createElement('canvas')
  canvas.className = 'pdf-edit-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.width = Math.floor(vp.width * ratio)
  canvas.height = Math.floor(vp.height * ratio)
  await page.render({
    canvas,
    viewport: vp,
    annotationMode: lib.AnnotationMode.DISABLE,
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
  }).promise
  host.querySelector('.pdf-edit-canvas')?.remove()
  host.prepend(canvas)
  host.dataset.drawn = 'true'
}

export async function layOutText(lib: PdfJs, page: PdfPage, textHost: HTMLElement): Promise<void> {
  const div = document.createElement('div')
  div.className = 'textLayer'
  textHost.append(div)
  await new lib.TextLayer({
    textContentSource: await page.getTextContent(),
    container: div,
    viewport: page.getViewport({ scale: CSS_PER_POINT }),
  }).render()
}
