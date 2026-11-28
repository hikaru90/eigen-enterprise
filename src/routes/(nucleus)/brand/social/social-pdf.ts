import { openPdf } from '$lib/office/pdf/pdfjs'

/**
 * A PDF post's pages as slide images (wish 55fdb281: LinkedIn shows a PDF as a
 * document carousel). Each page is drawn by pdf.js at about the 1080 px a
 * carousel slide has, as a PNG data URL. A password-protected PDF can't be a
 * post (LinkedIn can't open it either) and fails loud.
 */
export type PdfPages = (url: string) => Promise<string[]>

const SLIDE_WIDTH = 1080

export const renderPdfPages: PdfPages = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Loading the PDF failed (HTTP ${res.status}).`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  let locked = false
  const task = await openPdf(bytes, () => {
    locked = true
    void task.destroy()
  })
  let doc
  try {
    doc = await task.promise
  } catch (err) {
    if (locked) throw new Error('This PDF needs a password, so its pages can’t be shown.', { cause: err })
    throw err
  }
  try {
    const pages: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: SLIDE_WIDTH / base.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      await page.render({ canvas, viewport }).promise
      pages.push(canvas.toDataURL('image/png'))
      page.cleanup()
    }
    return pages
  } finally {
    await task.destroy()
  }
}
