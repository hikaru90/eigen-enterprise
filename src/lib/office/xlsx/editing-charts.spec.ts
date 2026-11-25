import { describe, expect, it } from 'vitest'
import { themeOf } from './chart-color'
import { plotData } from './chart-data'
import { describeCharts } from './chart-ops'
import { readChart } from './chart-read'
import { readClip } from './clip'
import { createSheetEditor, type SheetEditor } from './editor'
import { salesBook } from './test-utils/chart-fixtures'

/** Everyday editing (§7.7) with charts on the sheet (§7.4). */

const values = (ed: SheetEditor) => {
  const m = readChart(ed.wb.pkg.xml('/xl/charts/chart1.xml'), themeOf(ed.wb))
  return plotData(ed.wb, ed.calc(), m, m.plots[0]!, themeOf(ed.wb), 'en')[0]!.values
}

describe('everyday editing and charts', () => {
  it('cut and paste: chart series that read the moved cells follow them (same sheet and another sheet)', () => {
    const ed = createSheetEditor(salesBook())
    const before = describeCharts(ed.wb)[0]!.series[0]!
    expect(before.values).toBe('Data!$B$2:$B$5')
    const clip = readClip(ed, 'Data', { top: 0, left: 0, bottom: 4, right: 1 }, 'book')
    ed.apply({ op: 'paste', sheet: 'Data', at: 'H20', clip, cut: true })
    const after = describeCharts(ed.wb)[0]!.series[0]!
    expect(after).toMatchObject({
      values: 'Data!$I$21:$I$24',
      categories: 'Data!$H$21:$H$24',
      name_ref: 'Data!$I$20',
    })
    expect(values(ed)).toEqual([10, 20, 30, 40])
    // The anchor stays where it was (cut cells don't carry floating objects, as in Excel).
    expect(describeCharts(ed.wb)[0]!.position).toBe('E2:L16')
    ed.undo()
    expect(describeCharts(ed.wb)[0]!.series[0]!.values).toBe('Data!$B$2:$B$5')
  })

  it('a plain copy leaves chart series alone', () => {
    const ed = createSheetEditor(salesBook())
    const clip = readClip(ed, 'Data', { top: 0, left: 0, bottom: 4, right: 1 }, 'book')
    ed.apply({ op: 'paste', sheet: 'Data', at: 'H20', clip })
    expect(describeCharts(ed.wb)[0]!.series[0]!.values).toBe('Data!$B$2:$B$5')
  })

  it('hidden rows drop out of the chart (plot visible cells only) and come back when shown', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'hide_rows', sheet: 'Data', from: 2, to: 2, hidden: true })
    expect(values(ed)).toEqual([10, 30, 40])
    ed.apply({ op: 'hide_rows', sheet: 'Data', from: 2, to: 2, hidden: false })
    expect(values(ed)).toEqual([10, 20, 30, 40])
  })
})
