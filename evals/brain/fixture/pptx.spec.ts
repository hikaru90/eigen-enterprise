import { describe, expect, it } from 'vitest'
import { hasOfficeSignature } from '$lib/office/kinds'
import { readPackage, REL_OFFICE_DOCUMENT } from '$lib/office/ooxml/package'
import { buildPptx } from './pptx'

const SLIDES = [
  { title: 'Fjordlight & Co', bullets: ['AI <tooling>', 'Seed'] },
  { title: 'Traction', bullets: ['14 paying customers'] },
]

describe('fixture .pptx: a real PresentationML package, deterministic', () => {
  it('opens as an OPC package whose main part is the presentation, one slide part per slide', () => {
    const bytes = buildPptx(SLIDES)
    expect(hasOfficeSignature('pptx', bytes)).toBe(true)
    const pkg = readPackage(bytes)
    const main = pkg.mainPart(REL_OFFICE_DOCUMENT)
    expect(main).toBe('/ppt/presentation.xml')
    expect(pkg.contentType(main)).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')
    const slideRels = pkg.relationships(main).filter((r) => r.type.endsWith('/slide'))
    expect(slideRels.map((r) => r.part)).toEqual(['/ppt/slides/slide1.xml', '/ppt/slides/slide2.xml'])
    for (const part of ['/ppt/slideMasters/slideMaster1.xml', '/ppt/slideLayouts/slideLayout1.xml', '/ppt/theme/theme1.xml']) expect(pkg.has(part)).toBe(true)
  })

  it('writes titles and bullets as escaped text runs', () => {
    const pkg = readPackage(buildPptx(SLIDES))
    const texts = [...pkg.xml('/ppt/slides/slide1.xml').getElementsByTagName('a:t')].map((t) => t.textContent)
    expect(texts).toEqual(['Fjordlight & Co', 'AI <tooling>', 'Seed'])
  })

  it('the same slides give the same bytes', () => {
    expect(buildPptx(SLIDES)).toEqual(buildPptx(SLIDES))
  })
})
