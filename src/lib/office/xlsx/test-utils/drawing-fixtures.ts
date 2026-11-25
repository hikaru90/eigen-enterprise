import { strToU8, unzipSync, zipSync } from 'fflate'
import { buildXlsx, num, row, type BookSpec } from './build-xlsx'

/**
 * Workbooks with pictures, shapes, a chart frame, notes and threaded
 * comments, written the way Excel 365 writes them (drawing part, media, VML,
 * comments, threadedComments, persons), for the drawing and comment specs.
 */

const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

/** PNG signature + IHDR of a w×h picture (enough for the size reader; not a decodable image). */
export function png(w: number, h: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(new ArrayBuffer(33))
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const dv = new DataView(b.buffer)
  dv.setUint32(16, w)
  dv.setUint32(20, h)
  return b
}

const marker = (tag: string, col: number, colOff: number, rowN: number, rowOff: number) =>
  `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${rowN}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:${tag}>`

/** A picture over B2:D6 (one-cell editAs), a rectangle with text over F2:H4, a text box at absolute position, a chart frame, a group. */
export const DRAWING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}"><xdr:twoCellAnchor editAs="oneCell">${marker('from', 1, 0, 1, 0)}${marker('to', 3, 304800, 5, 95250)}<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1" descr="Company logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${R}" r:embed="rId1"/><a:srcRect l="10000" t="5000" r="20000"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm rot="5400000"><a:off x="609600" y="190500"/><a:ext cx="1524000" cy="857250"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor><xdr:twoCellAnchor>${marker('from', 5, 0, 1, 0)}${marker('to', 7, 0, 3, 0)}<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="3" name="Rectangle 2"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr><xdr:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></xdr:style><xdr:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="1100" b="1"/><a:t>Q3 target</a:t></a:r></a:p><a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>met</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor><xdr:absoluteAnchor><xdr:pos x="95250" y="1905000"/><xdr:ext cx="952500" cy="476250"/><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="4" name="TextBox 3"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></xdr:spPr><xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Note to self</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:absoluteAnchor><xdr:twoCellAnchor>${marker('from', 1, 0, 10, 0)}${marker('to', 6, 0, 20, 0)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="5" name="Chart 4"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${R}" r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor><xdr:oneCellAnchor>${marker('from', 9, 0, 1, 0)}<xdr:ext cx="1905000" cy="952500"/><xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="6" name="Group 5"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/><a:chOff x="0" y="0"/><a:chExt cx="1905000" cy="952500"/></a:xfrm></xdr:grpSpPr><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="7" name="Oval 6"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="952500" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="70AD47"/></a:solidFill></xdr:spPr></xdr:sp></xdr:grpSp><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`

export const CHART_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="${A}"><c:chart><c:plotArea><c:layout/></c:plotArea></c:chart></c:chartSpace>`

/** One sheet "Pics" with the drawing above, its picture /xl/media/image1.png and a chart part. */
export function pictureBook(extra: Partial<BookSpec> = {}): Uint8Array {
  const bytes = buildXlsx({
    sheets: [
      {
        name: 'Pics',
        rows: row(1, num('A1', 1)) + row(3, num('A3', 3)) + row(4, num('A4', 4)),
        after: '<drawing r:id="rId1"/>',
        rels: [{ id: 'rId1', type: 'drawing', target: '../drawings/drawing1.xml' }],
      },
      { name: 'Other', rows: row(1, num('A1', 9)) },
    ],
    parts: {
      '/xl/drawings/drawing1.xml': { xml: DRAWING_XML, type: 'application/vnd.openxmlformats-officedocument.drawing+xml' },
      '/xl/charts/chart1.xml': { xml: CHART_XML, type: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml' },
    },
    ...extra,
  })
  const files = unzipSync(bytes)
  files['xl/media/image1.png'] = png(160, 90)
  files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}image" Target="../media/image1.png"/><Relationship Id="rId2" Type="${REL}chart" Target="../charts/chart1.xml"/></Relationships>`,
  )
  files['[Content_Types].xml'] = strToU8(
    new TextDecoder()
      .decode(files['[Content_Types].xml'])
      .replace('<Default Extension="xml"', '<Default Extension="png" ContentType="image/png"/><Default Extension="xml"'),
  )
  return zipSync(files)
}

const NS_TC = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments'

export const COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Ada Lovelace</author><author>tc={11111111-1111-1111-1111-111111111111}</author></authors><commentList><comment ref="B2" authorId="0" shapeId="0"><text><r><rPr><b/><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/><family val="2"/></rPr><t>Ada Lovelace:</t></r><r><rPr><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/><family val="2"/></rPr><t xml:space="preserve">
Check this number</t></r></text></comment><comment ref="C4" authorId="1" shapeId="0"><text><t>[Threaded comment]

Comment:
    Is this final?</t></text></comment></commentList></comments>`

export const VML_XML = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype><v:shape id="_x0000_s1025" type="#_x0000_t202" style="position:absolute;margin-left:107.25pt;margin-top:7.5pt;width:108pt;height:59.25pt;z-index:1;visibility:visible" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>2, 15, 0, 10, 4, 15, 4, 4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>1</x:Row><x:Column>1</x:Column><x:Visible/></x:ClientData></v:shape><v:shape id="_x0000_s1026" type="#_x0000_t202" style="position:absolute;margin-left:155.25pt;margin-top:37.5pt;width:108pt;height:59.25pt;z-index:2;visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>3, 15, 2, 10, 5, 15, 6, 4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>3</x:Row><x:Column>2</x:Column></x:ClientData></v:shape></xml>`

export const THREADED_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ThreadedComments xmlns="${NS_TC}" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><threadedComment ref="C4" dT="2026-11-20T09:30:00.00" personId="{AAAAAAAA-0000-0000-0000-000000000001}" id="{11111111-1111-1111-1111-111111111111}"><text>Is this final?</text></threadedComment><threadedComment ref="C4" dT="2026-11-20T10:00:00.00" personId="{AAAAAAAA-0000-0000-0000-000000000002}" id="{22222222-2222-2222-2222-222222222222}" parentId="{11111111-1111-1111-1111-111111111111}"><text>@Ada Lovelace yes, signed off</text><mentions><mention mentionpersonId="{AAAAAAAA-0000-0000-0000-000000000001}" mentionId="{33333333-3333-3333-3333-333333333333}" startIndex="0" length="13"/></mentions></threadedComment></ThreadedComments>`

export const PERSONS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<personList xmlns="${NS_TC}" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><person displayName="Ada Lovelace" id="{AAAAAAAA-0000-0000-0000-000000000001}" userId="u-ada" providerId="None"/><person displayName="Grace Hopper" id="{AAAAAAAA-0000-0000-0000-000000000002}" userId="grace@example.com" providerId="AD"/></personList>`

/** Sheet "Notes" with a visible note on B2 (Ada) and a thread on C4 (Ada, a reply by Grace mentioning Ada), as Excel 365 saves them. */
export function commentBook(): Uint8Array {
  return buildXlsx({
    sheets: [
      {
        name: 'Notes',
        rows: row(2, num('B2', 42)) + row(4, num('C4', 7)) + row(6, num('A6', 6)),
        after: '<legacyDrawing r:id="rId2"/>',
        rels: [
          { id: 'rId1', type: 'comments', target: '../comments1.xml' },
          { id: 'rId2', type: 'vmlDrawing', target: '../drawings/vmlDrawing1.vml' },
          {
            id: 'rId3',
            type: 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment',
            target: '../threadedComments/threadedComment1.xml',
          },
        ],
      },
      { name: 'Plain', rows: row(1, num('A1', 1)) },
    ],
    parts: {
      '/xl/comments1.xml': {
        xml: COMMENTS_XML,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml',
      },
      '/xl/drawings/vmlDrawing1.vml': { xml: VML_XML, type: 'application/vnd.openxmlformats-officedocument.vmlDrawing' },
      '/xl/threadedComments/threadedComment1.xml': { xml: THREADED_XML, type: 'application/vnd.ms-excel.threadedcomments+xml' },
      '/xl/persons/person.xml': { xml: PERSONS_XML, type: 'application/vnd.ms-excel.person+xml' },
    },
    workbookRels: [{ type: 'http://schemas.microsoft.com/office/2017/10/relationships/person', target: 'persons/person.xml' }],
  })
}
