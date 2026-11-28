import { describe, expect, it } from 'vitest'
import { renderPdfPages } from './social-pdf'

/** A minimal two-page PDF (540 × 675 pt) with a correct cross-reference table. */
function twoPagePdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 675] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 675] >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

describe('brand social: PDF pages as slides', () => {
  it('draws every page of a PDF as a slide image about 1080 px wide', async () => {
    const url = URL.createObjectURL(new Blob([twoPagePdf()], { type: 'application/pdf' }))
    const pages = await renderPdfPages(url)
    expect(pages).toHaveLength(2)
    expect(pages[0]).toMatch(/^data:image\/png;base64,/)
    const img = new Image()
    img.src = pages[0]
    await img.decode()
    expect([img.naturalWidth, img.naturalHeight]).toEqual([1080, 1350])
  })
})
