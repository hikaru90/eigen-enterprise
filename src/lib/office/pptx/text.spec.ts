import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractOfficeText } from '../text'
import { extractText } from './text'
import { buildPptx, graphicFrame, para, ph, pic, PNG_1PX, sp, TABLE_URI, xfrm } from './test-utils/build-pptx'

describe('pptx extractText (Markdown for agents)', () => {
  it('one section per slide: title, body as nested lists, tables, notes', async () => {
    const cell = (t: string, attrs = '') => `<a:tc${attrs}><a:txBody><a:bodyPr/>${para(t)}</a:txBody><a:tcPr/></a:tc>`
    const tbl =
      `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1"/><a:gridCol w="1"/></a:tblGrid>` +
      `<a:tr h="1">${cell('Region')}${cell('Revenue | EUR')}</a:tr><a:tr h="1">${cell('North')}${cell('1.2m')}</a:tr><a:tr h="1">${cell('All', ' gridSpan="2"')}${cell('', ' hMerge="1"')}</a:tr></a:tbl>`
    const bytes = buildPptx({
      parts: { '/ppt/media/image1.png': { bytes: PNG_1PX, type: 'image/png' } },
      slides: [
        {
          layout: 2,
          shapes: sp({ id: 2, name: 'Title 1', ph: ph('ctrTitle'), body: para('Q3 review') }) + sp({ id: 3, name: 'Sub', ph: ph('subTitle', 1), body: para('Kindred, 2026') }),
          notes: ['Welcome everyone.', 'Keep it short.'],
        },
        {
          rels: [{ id: 'rIdP', type: 'image', target: '../media/image1.png' }],
          shapes:
            sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para('Results') }) +
            sp({ id: 3, name: 'Body', ph: ph(null, 1), body: para('Growth') + para('North +12%', { pPr: '<a:pPr lvl="1"/>' }) + para('') + para('Costs flat') }) +
            graphicFrame({ id: 4, name: 'Table 1', x: 0, y: 0, cx: 2, cy: 3, uri: TABLE_URI, data: tbl }) +
            pic({ id: 5, name: 'Photo', rId: 'rIdP', xfrm: xfrm(0, 0, 1, 1), descr: 'Team photo' }) +
            graphicFrame({ id: 6, name: 'Chart', x: 0, y: 0, cx: 1, cy: 1, uri: 'http://schemas.openxmlformats.org/drawingml/2006/chart', data: '' }) +
            sp({ id: 7, name: 'Slide Number', ph: ph('sldNum', 12), body: '<a:p><a:fld id="{1}" type="slidenum"><a:t>2</a:t></a:fld></a:p>' }),
        },
        { hidden: true, shapes: sp({ id: 3, name: 'Note box', xfrm: xfrm(0, 0, 1, 1), txBox: true, body: para('Backup slide') }) },
      ],
    })
    const md = await extractText(bytes)
    expect(md).toBe(
      [
        '## Slide 1: Q3 review',
        '',
        '- Kindred, 2026',
        '',
        '> Notes: Welcome everyone.',
        '> Keep it short.',
        '',
        '## Slide 2: Results',
        '',
        '- Growth',
        '  - North +12%',
        '- Costs flat',
        '',
        '| Region | Revenue \\| EUR |',
        '| --- | --- |',
        '| North | 1.2m |',
        '| All |  |',
        '',
        '_(Picture: Team photo)_',
        '',
        '_(Chart — not readable yet)_',
        '',
        '## Slide 3 (hidden)',
        '',
        '- Backup slide',
        '',
      ].join('\n'),
    )
  })

  it('is what drive.read gets for a deck, and a broken deck fails loud', async () => {
    const bytes = buildPptx({ slides: [{ shapes: sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para('Only') }) }] })
    expect(await extractOfficeText('pptx', bytes)).toBe('## Slide 1: Only\n')
    await expect(extractText(strToU8('nope'))).rejects.toThrow(/ZIP/)
  })
})
