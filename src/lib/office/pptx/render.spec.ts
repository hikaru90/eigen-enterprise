import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { openDeck } from './model'
import { renderSlideSvg, type RenderOptions } from './render'
import { resolveSlide } from './resolve'
import { buildPptx, graphicFrame, para, ph, pic, PNG_1PX, sp, TABLE_URI, xfrm, type DeckSpec } from './test-utils/build-pptx'

const opts = (over: Partial<RenderOptions> = {}): RenderOptions => ({ idPrefix: 't', media: (part) => ({ url: `blob:test${part}`, width: 10, height: 10 }), links: true, ...over })
const render = (spec: DeckSpec, o: Partial<RenderOptions> = {}) => {
  const { deck } = openDeck(buildPptx(spec))
  return renderSlideSvg(resolveSlide(deck, 0), opts(o))
}
/** The markup must be well-formed XML (it is injected as SVG). */
const parse = (svg: string) => {
  const errors: string[] = []
  const doc = new DOMParser({ onError: (level, msg) => level !== 'warning' && errors.push(msg) }).parseFromString(svg, 'image/svg+xml')
  expect(errors).toEqual([])
  return doc
}

describe('slide → SVG', () => {
  it('draws the background, shapes in slide pixels and text as HTML in foreignObject', () => {
    const svg = render({
      slides: [
        {
          shapes:
            sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para('Hello & <welcome>') }) +
            sp({ id: 4, name: 'Box', xfrm: xfrm(952500, 952500, 1905000, 952500, ' rot="5400000"'), geom: 'roundRect', spPr: '<a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill>' }),
        },
      ],
    })
    parse(svg)
    expect(svg).toContain('viewBox="0 0 1280 720"')
    expect(svg).toContain('<rect width="1280" height="720" fill="#ffffff"/>')
    expect(svg).toContain('data-shape="Box"')
    expect(svg).toContain('transform="translate(100 100) rotate(90 100 50)"')
    expect(svg).toContain('fill="#ff0000" fill-opacity="0.5"')
    expect(svg).toContain('<foreignObject')
    expect(svg).toContain('Hello &amp; &lt;welcome&gt;')
    expect(svg).toContain('font-family:&quot;Major Sans&quot;,sans-serif')
    expect(svg).not.toContain('<welcome>')
  })

  it('names what it cannot draw: unknown presets, charts, EMF pictures, missing table styles', () => {
    const svg = render({
      parts: { '/ppt/media/image1.emf': { bytes: new Uint8Array([1, 0, 0, 0]), type: 'image/x-emf' } },
      slides: [
        {
          rels: [{ id: 'rIdE', type: 'image', target: '../media/image1.emf' }],
          shapes:
            sp({ id: 3, name: 'Cloud', xfrm: xfrm(0, 0, 952500, 952500), geom: 'cloud' }) +
            graphicFrame({ id: 4, name: 'Chart', x: 0, y: 0, cx: 952500, cy: 952500, uri: 'http://schemas.openxmlformats.org/drawingml/2006/chart', data: '' }) +
            pic({ id: 5, name: 'Logo', rId: 'rIdE', xfrm: xfrm(0, 0, 952500, 952500) }),
        },
      ],
    })
    parse(svg)
    expect(svg).toContain('cloud shape — not drawn yet')
    expect(svg).toContain('Chart — not shown yet')
    expect(svg).toContain('EMF picture — not shown yet')
  })

  it('pictures use the media URL, cropped and clipped to the geometry', () => {
    const svg = render({
      parts: { '/ppt/media/image1.png': { bytes: PNG_1PX, type: 'image/png' } },
      slides: [{ rels: [{ id: 'rIdP', type: 'image', target: '../media/image1.png' }], shapes: pic({ id: 5, name: 'Photo', rId: 'rIdP', xfrm: xfrm(0, 0, 952500, 952500), crop: '<a:srcRect l="50000"/>', descr: 'Our team' }) }],
    })
    parse(svg)
    expect(svg).toContain('href="blob:test/ppt/media/image1.png"')
    expect(svg).toContain('x="-100" y="0" width="200" height="100"')
    expect(svg).toMatch(/<clipPath id="t-\d+">/)
    expect(svg).toContain('aria-label="Our team"')
  })

  it('hyperlinks: http(s) links open in a new tab, others are not links; thumbnails have none', () => {
    const spec: DeckSpec = {
      slides: [
        {
          rels: [
            { id: 'rIdA', type: 'hyperlink', target: 'https://example.com/?q="x"', external: true },
            { id: 'rIdB', type: 'hyperlink', target: 'javascript:alert(1)', external: true },
          ],
          shapes: sp({
            id: 4,
            name: 'T',
            xfrm: xfrm(0, 0, 952500, 952500),
            body: '<a:p><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rIdA"/></a:rPr><a:t>site</a:t></a:r><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rIdB"/></a:rPr><a:t>bad</a:t></a:r></a:p>',
          }),
        },
      ],
    }
    const svg = render(spec)
    parse(svg)
    expect(svg).toContain('<a href="https://example.com/?q=&quot;x&quot;" target="_blank" rel="noopener noreferrer"')
    expect(svg).not.toMatch(/href="javascript/)
    expect(svg).toContain('title="Link not supported: javascript:alert(1)"')
    expect(render(spec, { links: false })).not.toContain('<a ')
  })

  it('lines get dashes and arrowhead markers; tables become an HTML table', () => {
    const line = sp({ id: 3, name: 'Arrow', xfrm: xfrm(0, 0, 952500, 0), geom: 'straightConnector1', spPr: '<a:ln w="19050"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill><a:prstDash val="dash"/><a:tailEnd type="triangle"/></a:ln>' })
    const tbl = `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="952500"/><a:gridCol w="952500"/></a:tblGrid><a:tr h="381000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/>${para('Wide')}</a:txBody><a:tcPr anchor="ctr"/></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/>${para('')}</a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>`
    const svg = render({ slides: [{ shapes: line + graphicFrame({ id: 4, name: 'Table', x: 0, y: 0, cx: 1905000, cy: 381000, uri: TABLE_URI, data: tbl }) }] })
    parse(svg)
    expect(svg).toContain('stroke="#0000ff" stroke-width="2"')
    expect(svg).toContain('stroke-dasharray="8 6"')
    expect(svg).toMatch(/marker-end="url\(#t-\d+\)"/)
    expect(svg).toContain('<td colspan="2"')
    expect(svg).toContain('vertical-align:middle')
    expect((svg.match(/<td/g) ?? []).length).toBe(1)
  })

  it('bullets render as their own span with a hanging indent', () => {
    const svg = render({ slides: [{ shapes: sp({ id: 3, name: 'Body', ph: ph(null, 1), body: para('Point') }) }] })
    expect(svg).toMatch(/class="pptx-bullet"[^>]*style="[^"]*min-width:24px[^"]*">•<\/span>/)
    expect(svg).toContain('padding-left:24px;text-indent:-24px')
  })
})
