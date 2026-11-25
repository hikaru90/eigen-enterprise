import { buildXlsx, esc, num, row, str, type BookSpec } from './build-xlsx'

/**
 * Workbooks with charts for tests, written from ECMA-376 Part 1 §21.2 / §20.5
 * the way Excel lays them out: a sheet of data, its drawing part with a
 * two-cell anchor holding a chart frame, and the chart part with references
 * (`c:f`) and their caches.
 */

const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
export const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
export const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml'

const strCache = (vals: string[]) =>
  `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache>`
const numCache = (vals: number[]) =>
  `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache>`

export type FixtureSeries = {
  name: string
  nameRef: string
  cat: string
  catVals: string[]
  val: string
  vals: number[]
  color?: string
}

export const serXml = (s: FixtureSeries, i: number, extra = '') =>
  `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>${esc(s.nameRef)}</c:f>${strCache([s.name])}</c:strRef></c:tx>${s.color ? `<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></c:spPr>` : ''}<c:invertIfNegative val="0"/>${extra}<c:cat><c:strRef><c:f>${esc(s.cat)}</c:f>${strCache(s.catVals)}</c:strRef></c:cat><c:val><c:numRef><c:f>${esc(s.val)}</c:f>${numCache(s.vals)}</c:numRef></c:val></c:ser>`

export const AXES = `<c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="20"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:title><c:tx><c:rich><a:bodyPr rot="-5400000"/><a:p><a:r><a:rPr b="1"/><a:t>Euro</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="10"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`

/** A chart part: `plot` is the plot area's inside (groups + axes). */
export const chartXml = (plot: string, opts: { title?: string; legend?: string } = {}) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:date1904 val="0"/><c:roundedCorners val="0"/><c:chart>${opts.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>${esc(opts.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>'}<c:plotArea><c:layout/>${plot}</c:plotArea>${opts.legend ? `<c:legend><c:legendPos val="${opts.legend}"/><c:overlay val="0"/></c:legend>` : ''}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`

export const anchorXml = (
  rid: string,
  id: number,
  name: string,
  from: [number, number],
  to: [number, number],
  editAs = '',
) =>
  `<xdr:twoCellAnchor${editAs ? ` editAs="${editAs}"` : ''}><xdr:from><xdr:col>${from[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${to[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`

export const picAnchorXml = `<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="952500" cy="952500"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="9" name="Picture 1"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill/><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`

export const drawing = (anchors: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}">${anchors}</xdr:wsDr>`

const rels = (items: Array<[string, string, string]>) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join('')}</Relationships>`

/** Quarterly sales: A1:C5 (Quarter, North, South), a clustered column chart of B/C over A at E2:L16. */
export const SALES_ROWS =
  row(1, str('A1', 0) + str('B1', 1) + str('C1', 2)) +
  row(2, str('A2', 3) + num('B2', 10) + num('C2', 5)) +
  row(3, str('A3', 4) + num('B3', 20) + num('C3', 15)) +
  row(4, str('A4', 5) + num('B4', 30) + num('C4', 25)) +
  row(5, str('A5', 6) + num('B5', 40) + num('C5', 35))
export const SALES_STRINGS = ['Quarter', 'North', 'South', 'Q1', 'Q2', 'Q3', 'Q4']

const north: FixtureSeries = {
  name: 'North',
  nameRef: 'Data!$B$1',
  cat: 'Data!$A$2:$A$5',
  catVals: ['Q1', 'Q2', 'Q3', 'Q4'],
  val: 'Data!$B$2:$B$5',
  vals: [10, 20, 30, 40],
}
const south: FixtureSeries = {
  name: 'South',
  nameRef: 'Data!$C$1',
  cat: 'Data!$A$2:$A$5',
  catVals: ['Q1', 'Q2', 'Q3', 'Q4'],
  val: 'Data!$C$2:$C$5',
  vals: [5, 15, 25, 35],
  color: 'FF0000',
}

export const COLUMN_PLOT = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${serXml(north, 0)}${serXml(south, 1)}<c:gapWidth val="150"/><c:axId val="10"/><c:axId val="20"/></c:barChart>${AXES}`

export const PIE_PLOT = `<c:pieChart><c:varyColors val="1"/>${serXml(north, 0).replace('<c:invertIfNegative val="0"/>', '')}<c:firstSliceAng val="0"/></c:pieChart>`

/** The sales book with charts: `charts` are chart part XMLs placed on Data one below the other (E2:L16, E18:L32 …). */
export function salesBook(
  charts: string[] = [chartXml(COLUMN_PLOT, { title: 'Sales', legend: 'r' })],
  extra: Partial<BookSpec> & { drawingExtra?: string; editAs?: string } = {},
): Uint8Array {
  const parts: NonNullable<BookSpec['parts']> = {}
  const anchors: string[] = []
  charts.forEach((xml, i) => {
    parts[`/xl/charts/chart${i + 1}.xml`] = { xml, type: CT_CHART }
    anchors.push(
      anchorXml(
        `rId${i + 1}`,
        i + 2,
        `Chart ${i + 1}`,
        [4, 1 + i * 16],
        [12, 16 + i * 16],
        extra.editAs,
      ),
    )
  })
  parts['/xl/drawings/drawing1.xml'] = {
    xml: drawing(anchors.join('') + (extra.drawingExtra ?? '')),
    type: CT_DRAWING,
  }
  parts['/xl/drawings/_rels/drawing1.xml.rels'] = {
    xml: rels(charts.map((_, i) => [`rId${i + 1}`, 'chart', `../charts/chart${i + 1}.xml`])),
    type: 'application/vnd.openxmlformats-package.relationships+xml',
  }
  return buildXlsx({
    strings: SALES_STRINGS,
    ...extra,
    sheets: [
      {
        name: 'Data',
        rows: SALES_ROWS,
        after: '<drawing r:id="rId1"/>',
        rels: [{ id: 'rId1', type: 'drawing', target: '../drawings/drawing1.xml' }],
      },
      ...(extra.sheets ?? []),
    ],
    parts: { ...parts, ...(extra.parts ?? {}) },
  })
}
