import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { allCharts, chartsOn, NS_XDR } from './chart-anchor'
import { autoColor, themeOf } from './chart-color'
import { plotData, resolveRef } from './chart-data'
import { autoScale, layoutChart, type Mark } from './chart-layout'
import { describeCharts, seriesFromRange } from './chart-ops'
import { readChart } from './chart-read'
import { CHART_ORDER, plotAreaRank, serOrderOf } from './chart-write'
import { createSheetEditor, type SheetEditor } from './editor'
import { buildXlsx, num, row, str } from './test-utils/build-xlsx'
import {
  AXES,
  chartXml,
  COLUMN_PLOT,
  CT_CHART,
  picAnchorXml,
  PIE_PLOT,
  salesBook,
  serXml,
} from './test-utils/chart-fixtures'
import { openWorkbook, type Workbook } from './workbook'
import { kids, NS_CHART } from './xml'

const model = (wb: Workbook, part = '/xl/charts/chart1.xml') =>
  readChart(wb.pkg.xml(part), themeOf(wb))
const data = (ed: SheetEditor, part = '/xl/charts/chart1.xml') => {
  const m = model(ed.wb, part)
  return m.plots.map((p) => plotData(ed.wb, ed.calc(), m, p, themeOf(ed.wb), 'en'))
}
const reopen = (ed: SheetEditor) => createSheetEditor(ed.toBytes())
const zipText = (bytes: Uint8Array, name: string) => strFromU8(unzipSync(bytes)[name]!)
const rects = (marks: Mark[], series?: number) =>
  marks.filter(
    (m): m is Extract<Mark, { t: 'rect' }> =>
      m.t === 'rect' && m.series !== undefined && (series === undefined || m.series === series),
  )

/** Every chart-namespace element this writer knows the sequence of has its children in that order (ECMA-376 §21.2.2). */
function expectSchemaOrder(doc: XMLDocument) {
  const walk = (el: Element, parentName: string | null) => {
    const order =
      el.localName === 'ser' && parentName ? serOrderOf(parentName) : CHART_ORDER[el.localName!]
    const children = kids(el, undefined).filter((k) => k.namespaceURI === NS_CHART)
    const rank = (n: string) => (el.localName === 'plotArea' ? plotAreaRank(n) : n)
    if (order) {
      const idx = children.map((k) => order.indexOf(rank(k.localName!)))
      expect(
        idx.every((i) => i >= 0),
        `${el.localName}: ${children.map((k) => k.localName).join(',')}`,
      ).toBe(true)
      expect(
        [...idx].sort((a, b) => a - b),
        `${el.localName} children in schema order`,
      ).toEqual(idx)
    }
    for (const k of children) walk(k, el.localName!)
  }
  walk(doc.documentElement!, null)
}

describe('reading charts (DrawingML, ECMA-376 §21.2)', () => {
  it('reads a clustered column chart: series references and caches, title, legend, axes, colours', () => {
    const wb = openWorkbook(salesBook())
    const placed = chartsOn(wb, wb.requireSheet('Data'))
    expect(placed).toMatchObject([
      {
        id: 'chart1',
        name: 'Chart 1',
        part: '/xl/charts/chart1.xml',
        anchor: { kind: 'twoCell', from: { col: 4, row: 1 }, to: { col: 12, row: 16 } },
      },
    ])
    const m = model(wb)
    expect(m).toMatchObject({ title: 'Sales', legend: { pos: 'r' }, autoTitleDeleted: false })
    expect(m.plots).toHaveLength(1)
    expect(m.plots[0]).toMatchObject({
      kind: 'column',
      grouping: 'clustered',
      gapWidth: 150,
      axIds: [10, 20],
    })
    expect(
      m.plots[0]!.series.map((s) => [s.name.formula, s.cat?.formula, s.val?.formula, s.val?.cache]),
    ).toEqual([
      ['Data!$B$1', 'Data!$A$2:$A$5', 'Data!$B$2:$B$5', [10, 20, 30, 40]],
      ['Data!$C$1', 'Data!$A$2:$A$5', 'Data!$C$2:$C$5', [5, 15, 25, 35]],
    ])
    expect(m.plots[0]!.series[1]!.color).toBe('#FF0000')
    expect(m.axes.map((a) => [a.kind, a.pos, a.title, a.majorGridlines])).toEqual([
      ['cat', 'b', null, false],
      ['val', 'l', 'Euro', true],
    ])
  })

  it('automatic series colours follow the theme accents (style 2), darker after six', () => {
    const wb = openWorkbook(salesBook())
    const theme = themeOf(wb)
    expect(autoColor(0, theme)).toBe('#4472C4')
    expect(autoColor(1, theme)).toBe('#ED7D31')
    expect(autoColor(6, theme)).not.toBe('#4472C4')
  })
})

describe('series read live from the cells', () => {
  it('reads values and category labels from the referenced cells, and follows edits', () => {
    const ed = createSheetEditor(salesBook())
    let [ser] = data(ed)
    expect(ser!.map((s) => [s.name, s.categories, s.values, s.cached])).toEqual([
      ['North', ['Q1', 'Q2', 'Q3', 'Q4'], [10, 20, 30, 40], false],
      ['South', ['Q1', 'Q2', 'Q3', 'Q4'], [5, 15, 25, 35], false],
    ])
    ed.apply({
      op: 'set_cells',
      sheet: 'Data',
      cells: [
        { ref: 'B3', value: 99 },
        { ref: 'B1', value: 'Nord' },
        { ref: 'A2', value: 'Jan' },
      ],
    })
    ;[ser] = data(ed)
    expect(ser![0]).toMatchObject({
      name: 'Nord',
      categories: ['Jan', 'Q2', 'Q3', 'Q4'],
      values: [10, 99, 30, 40],
    })
  })

  it('falls back to the cached values only when a reference can’t be read, and says so', () => {
    const other = chartXml(COLUMN_PLOT.replace('Data!$B$2:$B$5', '[1]Data!$B$2:$B$5'))
    const ed = createSheetEditor(salesBook([other]))
    const [ser] = data(ed)
    expect(ser![0]).toMatchObject({ values: [10, 20, 30, 40], cached: true })
    expect(ser![1]).toMatchObject({ cached: false })
  })

  it('leaves out hidden rows (Excel’s plotVisOnly) and plots blanks as gaps', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'set_cells', sheet: 'Data', cells: [{ ref: 'C4', value: null }] })
    const wb = ed.wb
    const doc = wb.pkg.xml(wb.requireSheet('Data').part)
    // Hide row 3 (Q2) the way Excel writes it.
    const r3 = [...doc.getElementsByTagName('row')].find((r) => r.getAttribute('r') === '3')!
    r3.setAttribute('hidden', '1')
    wb.pkg.setXml(wb.requireSheet('Data').part, doc)
    wb.invalidate()
    const [ser] = data(ed)
    expect(ser![0]!.categories).toEqual(['Q1', 'Q3', 'Q4'])
    expect(ser![1]!.values).toEqual([5, null, 35])
  })

  it('resolves sheet-qualified ranges, unions and defined names; refuses other workbooks', () => {
    const wb = openWorkbook(
      salesBook([chartXml(COLUMN_PLOT)], {
        definedNames: '<definedName name="Norths">Data!$B$2:$B$5</definedName>',
      }),
    )
    expect(resolveRef(wb, "'Data'!$A$1:$A$3")).toEqual({
      sheet: 'Data',
      ranges: [{ top: 0, left: 0, bottom: 2, right: 0 }],
    })
    expect(resolveRef(wb, '(Data!$B$2,Data!$B$4:$B$5)')!.ranges).toHaveLength(2)
    expect(resolveRef(wb, 'Norths')).toEqual({
      sheet: 'Data',
      ranges: [{ top: 1, left: 1, bottom: 4, right: 1 }],
    })
    expect(resolveRef(wb, '[1]Data!$B$2')).toBeNull()
    expect(resolveRef(wb, 'Nowhere!$B$2')).toBeNull()
  })
})

describe('laying charts out (our SVG renderer)', () => {
  it('scales value axes the way Excel does: from zero, 1/2/5 steps, headroom on a tick', () => {
    expect(autoScale(10, 40, 8, null)).toEqual({ min: 0, max: 45, step: 5 })
    expect(autoScale(0, 7, 5, null)).toMatchObject({ min: 0, max: 8 })
    expect(autoScale(-12, 30, 5, null).min).toBeLessThan(-12)
    expect(autoScale(100, 105, 5, null).min).toBeGreaterThan(0)
    expect(autoScale(10, 40, 5, { min: 5, max: 50, majorUnit: 15 })).toEqual({
      min: 5,
      max: 50,
      step: 15,
    })
  })

  it('draws one bar per point and series, the taller value taller; title, legend and ticks as text', () => {
    const ed = createSheetEditor(salesBook())
    const scene = layoutChart(model(ed.wb), data(ed), 480, 288, {
      locale: 'en',
      theme: themeOf(ed.wb),
    })
    expect(rects(scene.marks, 0)).toHaveLength(4)
    expect(rects(scene.marks, 1)).toHaveLength(4)
    const [a, , , d] = rects(scene.marks, 0)
    expect(d!.h).toBeGreaterThan(a!.h * 3.5)
    expect(rects(scene.marks, 1)[0]!.fill).toBe('#FF0000')
    const texts = scene.marks.filter((m) => m.t === 'text').map((m) => (m as { text: string }).text)
    expect(texts).toEqual(expect.arrayContaining(['Sales', 'North', 'South', 'Q1', 'Q4', 'Euro']))
  })

  it('stacks bars, draws pies clockwise as slices, lines as paths, scatter as points', () => {
    const stacked = chartXml(
      COLUMN_PLOT.replace('<c:grouping val="clustered"/>', '<c:grouping val="stacked"/>').replace(
        '<c:gapWidth val="150"/>',
        '<c:gapWidth val="150"/><c:overlap val="100"/>',
      ),
    )
    const pie = chartXml(PIE_PLOT, { legend: 'r' })
    const line = chartXml(
      COLUMN_PLOT.replace(/barChart/g, 'lineChart')
        .replace('<c:barDir val="col"/>', '')
        .replace('<c:grouping val="clustered"/>', '<c:grouping val="standard"/>')
        .replace(/<c:invertIfNegative val="0"\/>/g, '')
        .replace('<c:gapWidth val="150"/>', '<c:marker val="1"/>'),
    )
    const ed = createSheetEditor(salesBook([stacked, pie, line]))
    const opts = { locale: 'en' as const, theme: themeOf(ed.wb) }
    const s = layoutChart(model(ed.wb), data(ed), 480, 288, opts)
    const [n0] = rects(s.marks, 0)
    const [s0] = rects(s.marks, 1)
    expect(Math.round(s0!.y + s0!.h)).toBe(Math.round(n0!.y))
    const p = layoutChart(
      model(ed.wb, '/xl/charts/chart2.xml'),
      data(ed, '/xl/charts/chart2.xml'),
      300,
      300,
      opts,
    )
    const slices = p.marks.filter((m) => m.t === 'path' && m.series === 0)
    expect(slices).toHaveLength(4)
    expect(new Set(slices.map((m) => (m as { fill: string }).fill)).size).toBe(4)
    expect(
      p.marks
        .filter((m) => m.t === 'text' && m.role === 'legend')
        .map((m) => (m as { text: string }).text),
    ).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
    const l = layoutChart(
      model(ed.wb, '/xl/charts/chart3.xml'),
      data(ed, '/xl/charts/chart3.xml'),
      480,
      288,
      opts,
    )
    expect(l.marks.filter((m) => m.t === 'path' && m.series !== undefined)).toHaveLength(2)
    expect(l.marks.filter((m) => m.t === 'circle' && m.series === 0)).toHaveLength(4)
  })
})

describe('inserting a chart (Excel-valid parts)', () => {
  it('makes the chart part, the drawing, relationships and content types; Excel’s series layout from the selection', () => {
    const ed = createSheetEditor(
      buildXlsx({
        strings: ['Quarter', 'North', 'South', 'Q1', 'Q2'],
        sheets: [
          {
            name: 'Data',
            rows:
              row(
                1,
                '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>',
              ) +
              row(2, '<c r="A2" t="s"><v>3</v></c>' + num('B2', 1) + num('C2', 2)) +
              row(3, '<c r="A3" t="s"><v>4</v></c>' + num('B3', 3) + num('C3', 4)),
          },
        ],
      }),
    )
    ed.apply({ op: 'chart_create', sheet: 'Data', type: 'column', range: 'A1:C3' })
    const bytes = ed.toBytes()
    const types = zipText(bytes, '[Content_Types].xml')
    expect(types).toContain(`PartName="/xl/charts/chart1.xml" ContentType="${CT_CHART}"`)
    expect(types).toContain(
      'PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"',
    )
    expect(zipText(bytes, 'xl/worksheets/_rels/sheet1.xml.rels')).toContain(
      'Target="../drawings/drawing1.xml"',
    )
    expect(zipText(bytes, 'xl/drawings/_rels/drawing1.xml.rels')).toContain(
      'Target="../charts/chart1.xml"',
    )
    const sheet = zipText(bytes, 'xl/worksheets/sheet1.xml')
    expect(sheet.indexOf('<pageMargins')).toBeLessThan(sheet.indexOf('<drawing'))
    const wb = openWorkbook(bytes)
    expectSchemaOrder(wb.pkg.xml('/xl/charts/chart1.xml'))
    const [c] = describeCharts(wb)
    expect(c).toMatchObject({
      id: 'chart1',
      types: ['column'],
      position: 'E1:L15',
      legend: 'b',
      series: [
        {
          values: 'Data!$B$2:$B$3',
          categories: 'Data!$A$2:$A$3',
          name: 'North',
          name_ref: 'Data!$B$1',
        },
        {
          values: 'Data!$C$2:$C$3',
          categories: 'Data!$A$2:$A$3',
          name: 'South',
          name_ref: 'Data!$C$1',
        },
      ],
    })
    // Caches written for programs that don't recalculate.
    expect(model(wb).plots[0]!.series[0]!.val!.cache).toEqual([1, 3])
    expect(model(wb).plots[0]!.series[0]!.cat!.cache).toEqual(['Q1', 'Q2'])
    expect(
      kids(wb.pkg.xml('/xl/drawings/drawing1.xml').documentElement!, 'twoCellAnchor', NS_XDR),
    ).toHaveLength(1)
  })

  it('lays series out by rows when the range is wider than tall, and takes x values for scatter', () => {
    const ed = createSheetEditor(salesBook())
    expect(
      seriesFromRange(ed.wb, ed.calc(), 'Data', 'B2:C5', 'column').map((s) => s.values),
    ).toEqual(['Data!$B$2:$B$5', 'Data!$C$2:$C$5'])
    expect(
      seriesFromRange(ed.wb, ed.calc(), 'Data', 'A1:C2', 'column').map((s) => s.values),
    ).toEqual(['Data!$B$2:$C$2'])
    expect(seriesFromRange(ed.wb, ed.calc(), 'Data', 'B2:C5', 'scatter')).toEqual([
      { values: 'Data!$C$2:$C$5', categories: 'Data!$B$2:$B$5', name: null },
    ])
  })

  it('every type writes a part in schema order; combos make one group per type with a secondary axis', () => {
    for (const type of [
      'column',
      'bar',
      'line',
      'area',
      'pie',
      'doughnut',
      'scatter',
      'bubble',
      'radar',
      'stock',
    ] as const) {
      const ed = createSheetEditor(salesBook([]))
      ed.apply({
        op: 'chart_create',
        sheet: 'Data',
        type,
        range: type === 'stock' ? 'A1:C5' : 'A1:C5',
        grouping: type === 'column' ? 'stacked' : undefined,
      })
      const wb = reopen(ed).wb
      const c = allCharts(wb).at(-1)!
      expectSchemaOrder(wb.pkg.xml(c.part))
      expect(model(wb, c.part).plots[0]!.kind).toBe(type)
    }
    const ed = createSheetEditor(salesBook([]))
    ed.apply({
      op: 'chart_create',
      sheet: 'Data',
      type: 'column',
      series: [
        { values: 'B2:B5', categories: 'A2:A5', name: { ref: 'B1' } },
        {
          values: 'C2:C5',
          categories: 'A2:A5',
          name: { text: 'Trend' },
          type: 'line',
          secondary: true,
        },
      ],
    })
    const wb = reopen(ed).wb
    const m = model(wb, allCharts(wb).at(-1)!.part)
    expect(m.plots.map((p) => [p.kind, p.secondary])).toEqual([
      ['column', false],
      ['line', true],
    ])
    expect(m.axes).toHaveLength(4)
    expect(m.axes.find((a) => a.pos === 'r')).toBeTruthy()
  })

  it('creates a chart sheet: a tab holding the chart', () => {
    const ed = createSheetEditor(salesBook([]))
    ed.apply({
      op: 'chart_create',
      sheet: 'Data',
      type: 'pie',
      range: 'A1:B5',
      newSheet: 'Sales chart',
    })
    const wb = reopen(ed).wb
    const info = wb.requireSheet('Sales chart')
    expect(info.kind).toBe('chartsheet')
    expect(chartsOn(wb, info)).toMatchObject([{ anchor: { kind: 'absolute' } }])
    expect(describeCharts(wb, 'Sales chart')[0]).toMatchObject({
      types: ['pie'],
      title: 'North',
      position: null,
    })
  })
})

describe('changing a chart', () => {
  const one = (ed: SheetEditor) => describeCharts(ed.wb, 'Data')[0]!

  it('title, legend, axis titles and scale, data labels, colours; other charts stay byte for byte', () => {
    const ed = createSheetEditor(
      salesBook([chartXml(COLUMN_PLOT, { title: 'Sales', legend: 'r' }), chartXml(PIE_PLOT)]),
    )
    const before = ed.wb.pkg.bytes('/xl/charts/chart2.xml')
    ed.apply({
      op: 'chart_update',
      sheet: 'Data',
      chart: 'chart1',
      title: 'Umsatz',
      legend: 't',
      axes: {
        category: { title: 'Quarter' },
        value: { min: 0, max: 50, format: '#,##0 €', gridlines: false },
      },
      labels: { value: true },
      colors: ['#00AA00', null],
    })
    const wb = reopen(ed).wb
    expectSchemaOrder(wb.pkg.xml('/xl/charts/chart1.xml'))
    expect(wb.pkg.bytes('/xl/charts/chart2.xml')).toEqual(before)
    const m = model(wb)
    expect(m.title).toBe('Umsatz')
    expect(m.legend).toEqual({ pos: 't' })
    expect(m.axes.map((a) => [a.title, a.min, a.max, a.numFmt?.code, a.majorGridlines])).toEqual([
      ['Quarter', null, null, 'General', false],
      ['Euro', 0, 50, '#,##0 €', false],
    ])
    expect(m.plots[0]!.series.map((s) => [s.color, !!s.labels?.value])).toEqual([
      ['#00AA00', true],
      [null, true],
    ])
    // The title keeps its run formatting (size 14 pt).
    expect(wb.pkg.text('/xl/charts/chart1.xml')).toMatch(/<a:rPr sz="1400"\/><a:t>Umsatz<\/a:t>/)
    ed.apply({
      op: 'chart_update',
      sheet: 'Data',
      chart: 'chart1',
      title: null,
      legend: null,
      labels: null,
    })
    expect(one(ed)).toMatchObject({ title: null, legend: null, labels: false })
  })

  it('changes the type and the series, keeping each series’ colour and the axis titles', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'chart_update', sheet: 'Data', chart: 'chart1', type: 'line' })
    let wb = reopen(ed).wb
    expectSchemaOrder(wb.pkg.xml('/xl/charts/chart1.xml'))
    let m = model(wb)
    expect(m.plots.map((p) => p.kind)).toEqual(['line'])
    expect(m.axes.find((a) => a.kind === 'val')!.title).toBe('Euro')
    ed.apply({
      op: 'chart_update',
      sheet: 'Data',
      chart: 'chart1',
      type: 'column',
      grouping: 'percentStacked',
    })
    ed.apply({
      op: 'chart_update',
      sheet: 'Data',
      chart: 'chart1',
      series: [{ values: 'C2:C5', categories: 'A2:A5', name: { ref: 'C1' } }],
    })
    wb = reopen(ed).wb
    expectSchemaOrder(wb.pkg.xml('/xl/charts/chart1.xml'))
    m = model(wb)
    expect(m.plots[0]).toMatchObject({ kind: 'column', grouping: 'percentStacked' })
    expect(m.plots[0]!.series.map((s) => s.val?.formula)).toEqual(['Data!$C$2:$C$5'])
    expect(() =>
      ed.apply({
        op: 'chart_update',
        sheet: 'Data',
        chart: 'chart1',
        series: [{ values: 'Nope!A1:A2' }],
      }),
    ).toThrow(/not a range/)
    expect(() => ed.apply({ op: 'chart_update', sheet: 'Data', chart: 'nope' })).toThrow(
      /has no chart “nope”/,
    )
  })

  it('moves and resizes, deletes (its parts and an emptied drawing go), and undoes', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'chart_move', sheet: 'Data', chart: 'Chart 1', to: 'H3:N20' })
    expect(one(ed).position).toBe('H3:N20')
    ed.apply({ op: 'chart_delete', sheet: 'Data', chart: 'chart1' })
    const bytes = ed.toBytes()
    const files = Object.keys(unzipSync(bytes))
    expect(files.filter((f) => f.includes('chart') || f.includes('drawing'))).toEqual([])
    expect(zipText(bytes, 'xl/worksheets/sheet1.xml')).not.toContain('<drawing')
    expect(zipText(bytes, '[Content_Types].xml')).not.toContain('chart1.xml')
    ed.undo()
    expect(one(ed).position).toBe('H3:N20')
  })

  it('keeps a drawing with a picture when its chart goes', () => {
    const ed = createSheetEditor(salesBook(undefined, { drawingExtra: picAnchorXml }))
    ed.apply({ op: 'chart_delete', sheet: 'Data', chart: 'chart1' })
    const wb = reopen(ed).wb
    expect(
      kids(wb.pkg.xml('/xl/drawings/drawing1.xml').documentElement!, undefined, NS_XDR),
    ).toHaveLength(1)
  })
})

describe('rows and columns moving under charts', () => {
  it('insert rows: series references and the anchor move with the cells; no losses to accept', () => {
    const ed = createSheetEditor(salesBook())
    const op = { op: 'insert_rows', sheet: 'Data', at: 0, count: 2 } as const
    expect(ed.losses(op)).toEqual([])
    ed.apply(op)
    const [c] = describeCharts(ed.wb)
    expect(c!.position).toBe('E4:L18')
    expect(c!.series[0]).toMatchObject({
      values: 'Data!$B$4:$B$7',
      categories: 'Data!$A$4:$A$7',
      name_ref: 'Data!$B$3',
    })
    expect(data(ed)[0]![0]!.values).toEqual([10, 20, 30, 40])
  })

  it('insert columns inside the chart widen it; delete rows of its data shrink its ranges; deleting all reads #REF!', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'insert_columns', sheet: 'Data', at: 6, count: 1 })
    expect(describeCharts(ed.wb)[0]!.position).toBe('E2:M16')
    ed.apply({ op: 'delete_rows', sheet: 'Data', at: 2, count: 1 })
    expect(describeCharts(ed.wb)[0]!.series[0]!.values).toBe('Data!$B$2:$B$4')
    ed.apply({ op: 'delete_columns', sheet: 'Data', at: 1, count: 1 })
    expect(describeCharts(ed.wb)[0]!.series[0]!.values).toBe('Data!#REF!')
    expect(data(ed)[0]![0]!.cached).toBe(true)
  })

  it('a chart that doesn’t move with cells (editAs absolute) stays; a picture beside it moves once, no loss asked', () => {
    const ed = createSheetEditor(
      salesBook(undefined, { editAs: 'absolute', drawingExtra: picAnchorXml }),
    )
    const op = { op: 'insert_rows', sheet: 'Data', at: 0, count: 1 } as const
    expect(ed.losses(op)).toEqual([])
    ed.apply(op)
    expect(describeCharts(ed.wb)[0]!.position).toBe('E2:L16')
    // The picture's anchor (row 9) moved one row, and only once (drawing.ts is the one anchor mover).
    expect(ed.wb.pkg.text('/xl/drawings/drawing1.xml')).toContain('<xdr:row>9</xdr:row>')
  })

  it('oneCell and editAs="oneCell" anchors move without resizing on insert/delete; chart sheets follow source cells', () => {
    const ed = createSheetEditor(salesBook(undefined, { editAs: 'oneCell' }))
    ed.apply({ op: 'chart_create', sheet: 'Data', type: 'line', range: 'A1:B5', newSheet: 'Trend' })
    ed.apply({ op: 'insert_rows', sheet: 'Data', at: 1, count: 2 })
    expect(describeCharts(ed.wb, 'Data')[0]!.position).toBe('E4:L18')
    expect(describeCharts(ed.wb, 'Trend')[0]!.series[0]!.values).toBe('Data!$B$4:$B$7')
    ed.apply({ op: 'insert_columns', sheet: 'Data', at: 5, count: 2 })
    // editAs="oneCell": inserting columns inside the chart span does NOT widen it.
    expect(describeCharts(ed.wb, 'Data')[0]!.position).toBe('E4:L18')
  })

  it('sorting rows moves anchored charts without reporting losses; series references stay, as in Excel, and plot the sorted cells live', () => {
    const ed = createSheetEditor(
      buildXlsx({
        strings: ['Name', 'Q1', 'Q2', 'bob', 'alice', 'carol'],
        sheets: [
          {
            name: 'Data',
            rows:
              row(1, str('A1', 0) + str('B1', 1) + str('C1', 2)) +
              row(2, str('A2', 3) + num('B2', 30) + num('C2', 35)) +
              row(3, str('A3', 4) + num('B3', 10) + num('C3', 15)) +
              row(4, str('A4', 5) + num('B4', 20) + num('C4', 25)),
          },
        ],
      }),
    )
    // Chart 1 sits inside the sorted rows (B2:C4); chart 2 outside (E2:K14) reads row 2 only.
    ed.apply({ op: 'chart_create', sheet: 'Data', type: 'column', range: 'A1:B4', at: 'B2:C4' })
    ed.apply({
      op: 'chart_create',
      sheet: 'Data',
      type: 'line',
      series: [{ name: { ref: 'A2' }, categories: 'B1:C1', values: 'B2:C2' }],
      at: 'E2:K14',
    })
    const sortOp = {
      op: 'sort_range' as const,
      sheet: 'Data',
      range: 'A1:C4',
      header: true,
      keys: [{ col: 1 }],
    }
    expect(ed.losses(sortOp)).toEqual([])
    ed.apply(sortOp)
    const charts = describeCharts(ed.wb, 'Data')
    // Row 2 (bob, 30) moved to row 4: Chart 1's anchor moved from row 1 (row 2) to row 3 (row 4).
    expect(charts[0]!.position).toBe('B4:C6')
    expect(charts[0]!.series[0]!.values).toBe('Data!$B$2:$B$4')
    expect(data(ed, '/xl/charts/chart1.xml')[0]![0]!.values).toEqual([10, 20, 30])
    // References into the sorted range are not rewritten (Excel's Data ▸ Sort): row 2 now holds alice.
    expect(charts[1]!.series[0]).toMatchObject({ name_ref: 'Data!$A$2', values: 'Data!$B$2:$C$2' })
    expect(data(ed, '/xl/charts/chart2.xml')[0]![0]).toMatchObject({
      name: 'alice',
      values: [10, 15],
    })
    ed.undo()
    expect(describeCharts(ed.wb, 'Data')[0]!.position).toBe('B2:C4')
    expect(describeCharts(ed.wb, 'Data')[1]!.series[0]!.values).toBe('Data!$B$2:$C$2')
  })

  it('renaming a sheet renames chart references (existing behaviour, kept)', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'rename_sheet', sheet: 'Data', name: 'Zahlen 2026' })
    expect(describeCharts(ed.wb)[0]!.series[0]!.values).toBe("'Zahlen 2026'!$B$2:$B$5")
  })
})

describe('round-trip and layout across all chart types and variants', () => {
  it('reads, writes, and lays out column/bar (clustered/stacked/100%), line (+markers, stacked, smooth), area (stacked), pie (% labels), doughnut, scatter, bubble, radar, and combo', () => {
    const ed = createSheetEditor(
      buildXlsx({
        strings: ['X', 'Y', 'Z', 'A', 'B', 'C', 'D'],
        sheets: [
          {
            name: 'Data',
            rows:
              row(1, str('A1', 0) + str('B1', 1) + str('C1', 2)) +
              row(2, num('A2', 1) + num('B2', 10) + num('C2', 20)) +
              row(3, num('A3', 2) + num('B3', 30) + num('C3', 40)) +
              row(4, num('A4', 3) + num('B4', 25) + num('C4', 15)),
          },
          {
            name: 'Cats',
            rows:
              row(1, str('A1', 0) + str('B1', 1) + str('C1', 2)) +
              row(2, str('A2', 3) + num('B2', 10) + num('C2', 5)) +
              row(3, str('A3', 4) + num('B3', 20) + num('C3', 15)) +
              row(4, str('A4', 5) + num('B4', 30) + num('C4', 25)) +
              row(5, str('A5', 6) + num('B5', 40) + num('C5', 35)),
          },
        ],
      }),
    )
    const opts = { locale: 'en' as const, theme: themeOf(ed.wb) }
    const variants: Array<{
      type: 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'bubble' | 'radar'
      grouping?: 'clustered' | 'stacked' | 'percentStacked' | 'standard'
      markers?: boolean
      labels?: { value?: boolean; percent?: boolean }
    }> = [
      { type: 'column', grouping: 'clustered' },
      { type: 'column', grouping: 'stacked' },
      { type: 'column', grouping: 'percentStacked' },
      { type: 'bar', grouping: 'clustered' },
      { type: 'bar', grouping: 'stacked' },
      { type: 'bar', grouping: 'percentStacked' },
      { type: 'line', grouping: 'standard', markers: false },
      { type: 'line', grouping: 'stacked', markers: true },
      { type: 'line', grouping: 'percentStacked', markers: true },
      { type: 'area', grouping: 'standard' },
      { type: 'area', grouping: 'stacked' },
      { type: 'area', grouping: 'percentStacked' },
      { type: 'pie', labels: { value: true, percent: true } },
      { type: 'doughnut' },
      { type: 'scatter' },
      { type: 'bubble' },
      { type: 'radar' },
    ]
    for (const v of variants) {
      const sheet = v.type === 'scatter' || v.type === 'bubble' ? 'Data' : 'Cats'
      const range = v.type === 'scatter' || v.type === 'bubble' ? 'A1:C4' : 'A1:C5'
      ed.apply({ op: 'chart_create', sheet, type: v.type, grouping: v.grouping, range })
      const c = chartsOn(ed.wb, ed.wb.requireSheet(sheet)).at(-1)!
      if (v.markers !== undefined || v.labels) {
        ed.apply({ op: 'chart_update', sheet, chart: c.id, markers: v.markers, labels: v.labels })
      }
      const wb = reopen(ed).wb
      expectSchemaOrder(wb.pkg.xml(c.part))
      const m = model(wb, c.part)
      const d = m.plots.map((p) => plotData(wb, ed.calc(), m, p, themeOf(wb), 'en'))
      const scene = layoutChart(m, d, 480, 288, opts)
      expect(scene.marks.length).toBeGreaterThan(3)
      if (v.type === 'bar') {
        const rs = rects(scene.marks)
        expect(rs.length).toBeGreaterThan(0)
        // Horizontal bars: taller value has greater width (w).
        expect(rs.some((r) => r.w > r.h)).toBe(true)
      } else if (v.type === 'area') {
        expect(
          scene.marks.some((m) => m.t === 'path' && m.series !== undefined && m.fill !== 'none'),
        ).toBe(true)
      } else if (v.type === 'doughnut') {
        expect(scene.marks.filter((m) => m.t === 'path' && m.series === 0)).toHaveLength(4)
        expect(scene.marks.filter((m) => m.t === 'path' && m.series === 1)).toHaveLength(4)
      } else if (v.type === 'scatter') {
        expect(d[0]![0]!.x).toEqual([1, 2, 3])
        expect(scene.marks.filter((m) => m.t === 'circle' && m.series === 0)).toHaveLength(3)
      } else if (v.type === 'bubble') {
        expect(d[0]![0]!.sizes).toEqual([20, 40, 15])
        expect(scene.marks.filter((m) => m.t === 'circle' && m.series === 0)).toHaveLength(3)
      } else if (v.type === 'radar') {
        expect(scene.marks.filter((m) => m.t === 'path' && m.series !== undefined)).toHaveLength(2)
      } else if (v.type === 'pie' && v.labels?.percent) {
        expect(
          scene.marks.some((m) => m.t === 'text' && m.role === 'label' && m.text.includes('%')),
        ).toBe(true)
      } else if (v.type === 'line' && v.markers === false) {
        expect(scene.marks.filter((m) => m.t === 'circle' && m.series !== undefined)).toHaveLength(
          0,
        )
      } else if (v.type === 'line' && v.markers === true) {
        expect(scene.marks.filter((m) => m.t === 'circle' && m.series === 0)).toHaveLength(4)
      }
    }
  })

  it('untouched charts and cross-sheet live references stay consistent and byte-for-byte', () => {
    const ed = createSheetEditor(
      salesBook([chartXml(COLUMN_PLOT, { title: 'One' }), chartXml(PIE_PLOT, { title: 'Two' })]),
    )
    const before2 = ed.wb.pkg.bytes('/xl/charts/chart2.xml')
    ed.apply({
      op: 'chart_create',
      sheet: 'Data',
      type: 'line',
      range: 'A1:B5',
      newSheet: 'LineTab',
    })
    ed.apply({ op: 'set_cells', sheet: 'Data', cells: [{ ref: 'B2', value: 100 }] })
    const out = reopen(ed)
    expect(out.wb.pkg.bytes('/xl/charts/chart2.xml')).toEqual(before2)
    expect(data(out, '/xl/charts/chart3.xml')[0]![0]!.values).toEqual([100, 20, 30, 40])
    expect(describeCharts(out.wb, 'LineTab')[0]!.types).toEqual(['line'])
  })
})

describe('chart parts this editor did not write', () => {
  it('an unsupported group is kept and named; the rest of the part is read', () => {
    const xml = chartXml(
      `<c:surfaceChart><c:wireframe val="0"/>${serXml({ name: 'A', nameRef: 'Data!$B$1', cat: 'Data!$A$2:$A$5', catVals: [], val: 'Data!$B$2:$B$5', vals: [] }, 0)}<c:axId val="10"/><c:axId val="20"/></c:surfaceChart>${AXES}`,
    )
    const ed = createSheetEditor(salesBook([xml]))
    expect(describeCharts(ed.wb)[0]!.unsupported).toEqual(['surfaceChart'])
    expect(() =>
      ed.apply({ op: 'chart_update', sheet: 'Data', chart: 'chart1', type: 'line' }),
    ).toThrow(/doesn't change/)
    ed.apply({ op: 'chart_update', sheet: 'Data', chart: 'chart1', title: 'Kept' })
    expect(reopen(ed).wb.pkg.text('/xl/charts/chart1.xml')).toContain('<c:surfaceChart>')
  })
})
