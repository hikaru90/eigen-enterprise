import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { ChartKind, Grouping, LegendPos } from '$lib/office/xlsx/chart-read'
import type { AxisPatch, LabelPatch, SeriesDef } from '$lib/office/xlsx/chart-write'
import { DRIVE_MODULE_ID } from './manifest'
import { DriveError } from './service'
import {
  DRIVE_ROLES,
  fileId,
  guarded,
  nameOf,
  openBook,
  save,
  sheetName,
  xlsx,
  type DriveSheetToolDeps,
} from './sheet-tools'

/**
 * drive.sheet_chart_* — the spreadsheet editor's charts as registry actions
 * (src/lib/office/xlsx/chart-ops.ts): list charts (type, title, series, axes,
 * position), insert a chart from a range or explicit series (on a sheet or a
 * new chart sheet), update type/title/series/legend/axes/labels/colours/position,
 * and delete. Every write saves one new revision under the same lock and
 * conflict checks as the rest of drive.sheet_*.
 */

const CHART_TYPE_VALUES = [
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
] as const satisfies readonly ChartKind[]

const GROUPING_VALUES = [
  'clustered',
  'stacked',
  'percentStacked',
  'standard',
] as const satisfies readonly Grouping[]

const LEGEND_VALUES = ['r', 'l', 't', 'b', 'tr'] as const satisfies readonly LegendPos[]

const LABEL_POS_VALUES = [
  'ctr',
  'inEnd',
  'outEnd',
  'inBase',
  't',
  'b',
  'l',
  'r',
  'bestFit',
] as const

const chartKind = z.enum(CHART_TYPE_VALUES)
const groupingKind = z.enum(GROUPING_VALUES)
const legendPos = z.enum(LEGEND_VALUES)
const colorHex = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .describe('A hex colour like #4472C4')

const seriesInput = z
  .object({
    values: z
      .string()
      .min(1)
      .max(255)
      .describe('Values range (y values for scatter/bubble), e.g. B2:B9 or Data!$B$2:$B$9'),
    categories: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .optional()
      .describe('Category labels (x values for scatter/bubble), e.g. A2:A9'),
    sizes: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .optional()
      .describe('Bubble sizes range (bubble charts)'),
    name: z.string().max(255).nullable().optional().describe('Literal series name'),
    name_ref: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .optional()
      .describe('Cell reference for the series name, e.g. B1'),
    type: chartKind.optional().describe('Combo chart: this series own chart type'),
    secondary: z.boolean().optional().describe('Plot against the secondary (right) value axis'),
  })
  .strict()

type SeriesInput = z.infer<typeof seriesInput>

function toSeriesDef(s: SeriesInput): SeriesDef {
  if (s.name !== undefined && s.name !== null && s.name_ref !== undefined && s.name_ref !== null)
    throw new DriveError('invalid', 'Give either name or name_ref for a series, not both.')
  const name: SeriesDef['name'] =
    s.name_ref !== undefined
      ? s.name_ref === null
        ? null
        : { ref: s.name_ref }
      : s.name !== undefined
        ? s.name === null
          ? null
          : { text: s.name }
        : undefined
  return {
    values: s.values,
    ...(s.categories !== undefined ? { categories: s.categories } : {}),
    ...(s.sizes !== undefined ? { sizes: s.sizes } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(s.type !== undefined ? { type: s.type } : {}),
    ...(s.secondary !== undefined ? { secondary: s.secondary } : {}),
  }
}

const axisPatchInput = z
  .object({
    title: z.string().max(500).nullable().optional().describe('Axis title; null removes it'),
    min: z.number().finite().nullable().optional().describe('Fixed minimum; null for auto'),
    max: z.number().finite().nullable().optional().describe('Fixed maximum; null for auto'),
    format: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .optional()
      .describe('Number format code, e.g. #,##0 €; null links to cell format'),
    gridlines: z.boolean().optional().describe('Show major gridlines'),
  })
  .strict()

const labelsInput = z
  .object({
    value: z.boolean().optional(),
    category: z.boolean().optional(),
    series: z.boolean().optional(),
    percent: z.boolean().optional().describe('Pie/doughnut share percentage'),
    position: z.enum(LABEL_POS_VALUES).nullable().optional(),
  })
  .strict()

const listInput = z
  .object({
    file_id: fileId,
    sheet: sheetName.optional().describe('Limit to charts on this sheet; omit for all sheets'),
  })
  .strict()

const createInput = z
  .object({
    file_id: fileId,
    sheet: sheetName.describe(
      'Sheet where the data lives (and where the chart is placed unless new_sheet is set)',
    ),
    type: chartKind.default('column').describe('Chart type (default: column)'),
    grouping: groupingKind.optional().describe('clustered, stacked, percentStacked, or standard'),
    range: z
      .string()
      .min(2)
      .max(40)
      .optional()
      .describe('Selection range to chart, e.g. A1:C5 (series guessed from header/orientation)'),
    series: z
      .array(seriesInput)
      .min(1)
      .max(100)
      .optional()
      .describe('Explicit series instead of range'),
    at: z
      .string()
      .min(2)
      .max(30)
      .optional()
      .describe('Anchor cell range on the sheet, e.g. E2:L18; omitted: placed next to data'),
    title: z.string().max(500).nullable().optional().describe('Chart title; null omits it'),
    legend: legendPos
      .nullable()
      .optional()
      .describe('Legend position (r, l, t, b, tr); null hides it'),
    new_sheet: sheetName
      .optional()
      .describe('Create the chart as a full chart sheet with this name'),
  })
  .strict()

const updateInput = z
  .object({
    file_id: fileId,
    sheet: sheetName.describe('Sheet (or chart sheet) holding the chart'),
    chart: z.string().min(1).max(100).describe('Chart id (e.g. chart1) or name (e.g. Chart 1)'),
    type: chartKind.optional(),
    grouping: groupingKind.optional(),
    title: z.string().max(500).nullable().optional().describe('Chart title; null removes it'),
    legend: legendPos.nullable().optional().describe('Legend position; null hides it'),
    series: z.array(seriesInput).min(1).max(100).optional().describe('Replace series definitions'),
    axes: z
      .object({
        category: axisPatchInput.optional(),
        value: axisPatchInput.optional(),
        secondary: axisPatchInput.optional(),
      })
      .strict()
      .optional(),
    labels: labelsInput.nullable().optional().describe('Data labels; null removes them'),
    colors: z
      .array(colorHex.nullable())
      .max(100)
      .optional()
      .describe('Per-series colours (#RRGGBB; null resets to theme automatic)'),
    markers: z.boolean().optional().describe('Show markers on line/scatter/radar series'),
    position: z
      .string()
      .min(2)
      .max(30)
      .optional()
      .describe('Move or resize the chart to cover this cell range, e.g. H3:N20'),
  })
  .strict()

const deleteInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    chart: z.string().min(1).max(100).describe('Chart id (e.g. chart1) or name (e.g. Chart 1)'),
  })
  .strict()

function toAxisPatch(p: z.infer<typeof axisPatchInput>): AxisPatch {
  return {
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.format !== undefined ? { format: p.format } : {}),
    ...(p.gridlines !== undefined ? { gridlines: p.gridlines } : {}),
  }
}

export function createDriveSheetChartTools({ service }: DriveSheetToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_chart_list',
      module: DRIVE_MODULE_ID,
      summary:
        'List the charts in an Excel workbook (.xlsx) in Drive (file_id, optional sheet): id, name, sheet, types, grouping, title, position range, legend, series (name, values, categories, sizes, type, secondary, color, markers), axes (role, title, min, max, format, gridlines), data labels, and any unsupported groups.',
      auditClass: 'read',
      permission: { roles: DRIVE_ROLES },
      inputSchema: listInput,
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        const lib = await xlsx()
        const { file, editor } = await openBook(await service(), ctx, i.file_id, lib)
        return guarded(lib, () => ({
          file: { id: file.id, name: file.name },
          charts: lib.chartOps.describeCharts(editor.wb, i.sheet),
        }))
      },
    },
    {
      name: 'drive.sheet_chart_create',
      module: DRIVE_MODULE_ID,
      summary:
        'Insert a chart into an Excel workbook (.xlsx) in Drive (file_id, sheet, type: column|bar|line|area|pie|doughnut|scatter|bubble|radar|stock, range or explicit series, optional grouping, at cell range, title, legend, or new_sheet for a chart sheet). Combo charts use per-series type and secondary: true. Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof createInput>, output: unknown) => {
        const name = nameOf(output)
        const where = input.new_sheet ?? input.sheet
        return name
          ? `Created a ${input.type} chart in ${where} of ${name} in Drive`
          : `Tried to create a chart in file ${input.file_id} in Drive`
      },
      inputSchema: createInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = createInput.parse(input)
        if (!i.range && !i.series?.length)
          throw new DriveError('invalid', 'A chart needs its data: give range or series.')
        if (i.at && i.new_sheet)
          throw new DriveError(
            'invalid',
            'Give either at (position on this sheet) or new_sheet (a chart sheet), not both.',
          )
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        const series = i.series?.map(toSeriesDef)
        const targetSheet = await guarded(lib, () => {
          const res = editor.apply({
            op: 'chart_create',
            sheet: i.sheet,
            type: i.type,
            ...(i.grouping !== undefined ? { grouping: i.grouping } : {}),
            ...(i.range !== undefined ? { range: i.range } : {}),
            ...(series ? { series } : {}),
            ...(i.at !== undefined ? { at: i.at } : {}),
            ...(i.title !== undefined ? { title: i.title } : {}),
            ...(i.legend !== undefined ? { legend: i.legend } : {}),
            ...(i.new_sheet !== undefined ? { newSheet: i.new_sheet } : {}),
          })
          return res.focus ?? editor.wb.requireSheet(i.sheet).name
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const chart = lib.chartOps.describeCharts(editor.wb, targetSheet).at(-1)!
        return { ...saved, sheet: targetSheet, chart }
      },
    },
    {
      name: 'drive.sheet_chart_update',
      module: DRIVE_MODULE_ID,
      summary:
        'Update a chart in an Excel workbook (.xlsx) in Drive (file_id, sheet, chart id or name): change type, grouping, title, legend, series, axes (category/value/secondary title, min, max, format, gridlines), data labels, series colours, markers, or position range. Saved as one new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof updateInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Updated chart ${input.chart} in ${input.sheet} of ${name} in Drive`
          : `Tried to update chart ${input.chart} in file ${input.file_id} in Drive`
      },
      inputSchema: updateInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = updateInput.parse(input)
        const hasUpdate =
          i.type !== undefined ||
          i.grouping !== undefined ||
          i.title !== undefined ||
          i.legend !== undefined ||
          i.series !== undefined ||
          i.axes !== undefined ||
          i.labels !== undefined ||
          i.colors !== undefined ||
          i.markers !== undefined
        if (!hasUpdate && i.position === undefined)
          throw new DriveError(
            'invalid',
            'Nothing to update: pass at least one chart change or position.',
          )
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        const series = i.series?.map(toSeriesDef)
        const chartId = await guarded(lib, () => {
          const placed = lib.chartOps.requireChart(editor.wb, i.sheet, i.chart)
          if (hasUpdate) {
            const labels: LabelPatch | null | undefined =
              i.labels === undefined
                ? undefined
                : i.labels === null
                  ? null
                  : {
                      ...(i.labels.value !== undefined ? { value: i.labels.value } : {}),
                      ...(i.labels.category !== undefined ? { category: i.labels.category } : {}),
                      ...(i.labels.series !== undefined ? { series: i.labels.series } : {}),
                      ...(i.labels.percent !== undefined ? { percent: i.labels.percent } : {}),
                      ...(i.labels.position !== undefined ? { position: i.labels.position } : {}),
                    }
            editor.apply({
              op: 'chart_update',
              sheet: placed.sheet,
              chart: placed.id,
              ...(i.type !== undefined ? { type: i.type } : {}),
              ...(i.grouping !== undefined ? { grouping: i.grouping } : {}),
              ...(i.title !== undefined ? { title: i.title } : {}),
              ...(i.legend !== undefined ? { legend: i.legend } : {}),
              ...(series ? { series } : {}),
              ...(i.axes
                ? {
                    axes: {
                      ...(i.axes.category ? { category: toAxisPatch(i.axes.category) } : {}),
                      ...(i.axes.value ? { value: toAxisPatch(i.axes.value) } : {}),
                      ...(i.axes.secondary ? { secondary: toAxisPatch(i.axes.secondary) } : {}),
                    },
                  }
                : {}),
              ...(labels !== undefined ? { labels } : {}),
              ...(i.colors !== undefined ? { colors: i.colors } : {}),
              ...(i.markers !== undefined ? { markers: i.markers } : {}),
            })
          }
          if (i.position !== undefined)
            editor.apply({
              op: 'chart_move',
              sheet: placed.sheet,
              chart: placed.id,
              to: i.position,
            })
          return placed
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const chart = lib.chartOps
          .describeCharts(editor.wb, chartId.sheet)
          .find((c) => c.id === chartId.id)!
        return { ...saved, sheet: chartId.sheet, chart }
      },
    },
    {
      name: 'drive.sheet_chart_delete',
      module: DRIVE_MODULE_ID,
      summary:
        'Delete a chart from a worksheet in an Excel workbook (.xlsx) in Drive (file_id, sheet, chart id or name). Removes the chart part and an emptied drawing while keeping any pictures or shapes. Chart sheets are deleted with drive.sheet_structure delete_sheet. Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof deleteInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Deleted chart ${input.chart} from ${input.sheet} of ${name} in Drive`
          : `Tried to delete chart ${input.chart} in file ${input.file_id} in Drive`
      },
      inputSchema: deleteInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = deleteInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        const target = await guarded(lib, () => {
          const placed = lib.chartOps.requireChart(editor.wb, i.sheet, i.chart)
          editor.apply({ op: 'chart_delete', sheet: placed.sheet, chart: placed.id })
          return placed
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheet: target.sheet, deleted: target.id }
      },
    },
  ]
}
