import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { CfRuleInput, CfRuleView, CfStyle } from '$lib/office/xlsx/cond-format'
import type { SheetOp } from '$lib/office/xlsx/ops'
import type { SheetAllow } from '$lib/office/xlsx/protection'
import {
  CF_OPERATORS,
  CF_TYPES,
  CFVO_KINDS,
  ERROR_STYLES,
  ICON_SET_NAMES,
  TIME_PERIODS,
  VALIDATION_OPERATORS,
  VALIDATION_TYPES,
} from '$lib/office/xlsx/rules-choices'
import type { ValidationRule } from '$lib/office/xlsx/validation'
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
 * drive.sheet_* rules, links, names and protection tools: conditional
 * formatting, data validation, hyperlinks, Name Manager and sheet/workbook
 * protection — the exact same operations the grid runs (./cond-format.ts,
 * ./validation.ts, ./hyperlinks.ts, ./names.ts, ./protection.ts), saved as
 * new revisions of the workbook with conflict and edit-lock protection.
 */

const rulesLib = async () => {
  const [condFormat, names] = await Promise.all([
    import('$lib/office/xlsx/cond-format'),
    import('$lib/office/xlsx/names'),
  ])
  return { condFormat, names }
}

const colorHex = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .describe('A colour like #63BE7B')
const sqrefText = z
  .string()
  .min(2)
  .max(1000)
  .describe('Cell range or range list, e.g. A1:C10 or A1:A5 C1:C5')
const rangeText = z.string().min(2).max(30).describe('A cell or range like B3 or A1:C1')

const cfStyleSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    font_color: colorHex.optional(),
    fill: colorHex.optional(),
    border: colorHex.optional(),
    num_fmt: z.string().min(1).max(255).optional(),
  })
  .strict()

const cfvoSchema = z
  .object({
    kind: z.enum(CFVO_KINDS),
    value: z.string().max(1000).nullable().optional(),
  })
  .strict()

const cfRuleSchema = z
  .object({
    type: z.enum(CF_TYPES),
    operator: z.enum(CF_OPERATORS).optional(),
    formula1: z.string().min(1).max(8000).optional(),
    formula2: z.string().min(1).max(8000).optional(),
    text: z.string().min(1).max(255).optional(),
    period: z.enum(TIME_PERIODS).optional(),
    rank: z.number().int().min(1).max(1000).optional(),
    percent: z.boolean().optional(),
    bottom: z.boolean().optional(),
    below: z.boolean().optional(),
    equal_average: z.boolean().optional(),
    std_dev: z.number().int().min(1).max(3).optional(),
    style: cfStyleSchema.optional(),
    stop_if_true: z.boolean().optional(),
    points: z
      .array(
        z
          .object({
            kind: z.enum(CFVO_KINDS),
            value: z.string().max(1000).nullable().optional(),
            color: colorHex,
          })
          .strict(),
      )
      .min(2)
      .max(3)
      .optional(),
    bar: z
      .object({
        min: cfvoSchema.optional(),
        max: cfvoSchema.optional(),
        color: colorHex,
        gradient: z.boolean().optional(),
        show_value: z.boolean().optional(),
        border: z.boolean().optional(),
        negative_color: colorHex.optional(),
        axis: z.enum(['automatic', 'middle', 'none']).optional(),
      })
      .strict()
      .optional(),
    icons: z
      .object({
        set: z.enum(ICON_SET_NAMES),
        thresholds: z
          .array(
            z
              .object({
                kind: z.enum(CFVO_KINDS),
                value: z.string().max(1000),
                gte: z.boolean().optional(),
              })
              .strict(),
          )
          .min(2)
          .max(4)
          .optional(),
        reverse: z.boolean().optional(),
        show_value: z.boolean().optional(),
        custom: z
          .array(
            z
              .object({
                set: z.enum([...ICON_SET_NAMES, 'NoIcons'] as const),
                index: z.number().int().min(0).max(4),
              })
              .strict(),
          )
          .min(3)
          .max(5)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const cfListInput = z.object({ file_id: fileId, sheet: sheetName }).strict()

const cfSetInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    range: sqrefText.optional().describe('Target cells (required when adding a new rule)'),
    priority: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Existing rule priority (1 = highest) to update or move; omit to add a new rule at priority 1',
      ),
    move_to: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('New priority position (used with priority)'),
    rule: cfRuleSchema
      .optional()
      .describe('Conditional format rule definition (required when adding)'),
  })
  .strict()

const cfDeleteInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    priority: z.number().int().min(1).optional().describe('Delete the rule with this priority'),
    range: z
      .string()
      .min(2)
      .max(1000)
      .nullable()
      .optional()
      .describe('Clear rules from these cells (or null to clear all rules on the sheet)'),
  })
  .strict()

const validationSetInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    range: sqrefText,
    type: z.enum(VALIDATION_TYPES),
    operator: z.enum(VALIDATION_OPERATORS).optional(),
    formula1: z.string().min(1).max(8000).optional(),
    formula2: z.string().min(1).max(8000).optional(),
    items: z
      .array(z.string().min(1).max(255))
      .min(1)
      .max(255)
      .optional()
      .describe('Inline list items (for type "list" without formula1)'),
    allow_blank: z.boolean().optional(),
    dropdown: z.boolean().optional(),
    input_title: z.string().max(32).nullable().optional(),
    input_message: z.string().max(255).nullable().optional(),
    error_style: z.enum(ERROR_STYLES).optional(),
    error_title: z.string().max(32).nullable().optional(),
    error_message: z.string().max(225).nullable().optional(),
    show_input: z.boolean().optional(),
    show_error: z.boolean().optional(),
  })
  .strict()

const validationClearInput = z
  .object({ file_id: fileId, sheet: sheetName, range: sqrefText })
  .strict()

const hyperlinkSetInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    range: rangeText,
    target: z
      .string()
      .min(1)
      .max(2079)
      .describe(
        'External URL (http/https/mailto/ftp) or internal place (Sheet2!A1, #Sheet2!A1, defined name)',
      ),
    tooltip: z.string().max(255).nullable().optional(),
    text: z.string().max(32_767).nullable().optional(),
  })
  .strict()

const hyperlinkRemoveInput = z
  .object({ file_id: fileId, sheet: sheetName, range: rangeText })
  .strict()

const namesListInput = z.object({ file_id: fileId }).strict()

const namesSetInput = z
  .object({
    file_id: fileId,
    name: z.string().min(1).max(255),
    scope: sheetName
      .nullable()
      .optional()
      .describe('Sheet name for a sheet-scoped name; omit or null for workbook scope'),
    new_name: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('New name when renaming an existing defined name'),
    refers_to: z
      .string()
      .min(1)
      .max(8000)
      .optional()
      .describe('Formula or reference (e.g. =Sheet1!$A$1:$A$10)'),
    comment: z.string().max(255).nullable().optional(),
  })
  .strict()

const namesDeleteInput = z
  .object({
    file_id: fileId,
    name: z.string().min(1).max(255),
    scope: sheetName
      .nullable()
      .optional()
      .describe('Sheet name for a sheet-scoped name; omit or null for workbook scope'),
  })
  .strict()

const sheetAllowInput = z
  .object({
    select_locked_cells: z.boolean().optional(),
    select_unlocked_cells: z.boolean().optional(),
    format_cells: z.boolean().optional(),
    format_columns: z.boolean().optional(),
    format_rows: z.boolean().optional(),
    insert_columns: z.boolean().optional(),
    insert_rows: z.boolean().optional(),
    insert_hyperlinks: z.boolean().optional(),
    delete_columns: z.boolean().optional(),
    delete_rows: z.boolean().optional(),
    sort: z.boolean().optional(),
    auto_filter: z.boolean().optional(),
    pivot_tables: z.boolean().optional(),
    objects: z.boolean().optional(),
    scenarios: z.boolean().optional(),
  })
  .strict()

const protectInput = z
  .object({
    file_id: fileId,
    action: z.enum([
      'protect_sheet',
      'unprotect_sheet',
      'protect_workbook',
      'unprotect_workbook',
      'set_cell_protection',
    ]),
    sheet: sheetName.optional().describe('Required for sheet and cell protection actions'),
    password: z
      .string()
      .max(255)
      .nullable()
      .optional()
      .describe('Optional password (hashed in the file; never logged or returned)'),
    allow: sheetAllowInput.optional().describe('Actions allowed when the sheet is protected'),
    range: z.string().min(2).max(30).optional().describe('Cell range for set_cell_protection'),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .strict()

const ALLOW_KEY: Record<keyof z.infer<typeof sheetAllowInput>, SheetAllow> = {
  select_locked_cells: 'selectLockedCells',
  select_unlocked_cells: 'selectUnlockedCells',
  format_cells: 'formatCells',
  format_columns: 'formatColumns',
  format_rows: 'formatRows',
  insert_columns: 'insertColumns',
  insert_rows: 'insertRows',
  insert_hyperlinks: 'insertHyperlinks',
  delete_columns: 'deleteColumns',
  delete_rows: 'deleteRows',
  sort: 'sort',
  auto_filter: 'autoFilter',
  pivot_tables: 'pivotTables',
  objects: 'objects',
  scenarios: 'scenarios',
}

function toCfStyle(s: z.infer<typeof cfStyleSchema>): CfStyle {
  return {
    ...(s.bold !== undefined ? { bold: s.bold } : {}),
    ...(s.italic !== undefined ? { italic: s.italic } : {}),
    ...(s.underline !== undefined ? { underline: s.underline } : {}),
    ...(s.strike !== undefined ? { strike: s.strike } : {}),
    ...(s.font_color !== undefined ? { fontColor: s.font_color } : {}),
    ...(s.fill !== undefined ? { fill: s.fill } : {}),
    ...(s.border !== undefined ? { border: s.border } : {}),
    ...(s.num_fmt !== undefined ? { numFmt: s.num_fmt } : {}),
  }
}

function toCfRuleInput(r: z.infer<typeof cfRuleSchema>): CfRuleInput {
  return {
    type: r.type,
    ...(r.operator !== undefined ? { operator: r.operator } : {}),
    ...(r.formula1 !== undefined ? { formula1: r.formula1 } : {}),
    ...(r.formula2 !== undefined ? { formula2: r.formula2 } : {}),
    ...(r.text !== undefined ? { text: r.text } : {}),
    ...(r.period !== undefined ? { period: r.period } : {}),
    ...(r.rank !== undefined ? { rank: r.rank } : {}),
    ...(r.percent !== undefined ? { percent: r.percent } : {}),
    ...(r.bottom !== undefined ? { bottom: r.bottom } : {}),
    ...(r.below !== undefined ? { below: r.below } : {}),
    ...(r.equal_average !== undefined ? { equalAverage: r.equal_average } : {}),
    ...(r.std_dev !== undefined ? { stdDev: r.std_dev } : {}),
    ...(r.style !== undefined ? { style: toCfStyle(r.style) } : {}),
    ...(r.stop_if_true !== undefined ? { stopIfTrue: r.stop_if_true } : {}),
    ...(r.points !== undefined ? { points: r.points } : {}),
    ...(r.bar !== undefined
      ? {
          bar: {
            color: r.bar.color,
            ...(r.bar.min !== undefined ? { min: r.bar.min } : {}),
            ...(r.bar.max !== undefined ? { max: r.bar.max } : {}),
            ...(r.bar.gradient !== undefined ? { gradient: r.bar.gradient } : {}),
            ...(r.bar.show_value !== undefined ? { showValue: r.bar.show_value } : {}),
            ...(r.bar.border !== undefined ? { border: r.bar.border } : {}),
            ...(r.bar.negative_color !== undefined ? { negativeColor: r.bar.negative_color } : {}),
            ...(r.bar.axis !== undefined ? { axis: r.bar.axis } : {}),
          },
        }
      : {}),
    ...(r.icons !== undefined
      ? {
          icons: {
            set: r.icons.set,
            ...(r.icons.thresholds !== undefined ? { thresholds: r.icons.thresholds } : {}),
            ...(r.icons.reverse !== undefined ? { reverse: r.icons.reverse } : {}),
            ...(r.icons.show_value !== undefined ? { showValue: r.icons.show_value } : {}),
            ...(r.icons.custom !== undefined ? { custom: r.icons.custom } : {}),
          },
        }
      : {}),
  }
}

function presentRule(r: CfRuleView) {
  return {
    priority: r.priority,
    type: r.type,
    sqref: r.sqref,
    stop_if_true: r.stopIfTrue,
    ...(r.style ? { style: r.style } : {}),
    ...(r.operator ? { operator: r.operator } : {}),
    ...(r.formulas.length ? { formulas: r.formulas } : {}),
    ...(r.text !== null ? { text: r.text } : {}),
    ...(r.period ? { period: r.period } : {}),
    ...(r.rank !== null ? { rank: r.rank, percent: r.percent, bottom: r.bottom } : {}),
    ...(r.type === 'aboveAverage'
      ? { below: r.below, equal_average: r.equalAverage, std_dev: r.stdDev }
      : {}),
    ...(r.colorScale ? { color_scale: r.colorScale } : {}),
    ...(r.dataBar ? { data_bar: r.dataBar } : {}),
    ...(r.iconSet ? { icon_set: r.iconSet } : {}),
    ...(r.extension ? { extension: true } : {}),
  }
}

function presentValidation(
  v: ReturnType<Awaited<ReturnType<typeof xlsx>>['validation']['validationsOf']>[number],
) {
  return {
    sqref: v.sqref,
    type: v.type,
    operator: v.operator,
    formula1: v.formula1,
    formula2: v.formula2,
    items: v.items,
    allow_blank: v.allowBlank,
    dropdown: v.dropdown,
    error_style: v.errorStyle,
    input_title: v.inputTitle,
    input_message: v.inputMessage,
    error_title: v.errorTitle,
    error_message: v.errorMessage,
    show_input: v.showInput,
    show_error: v.showError,
  }
}

export function createDriveSheetRulesTools({ service, sheetLive }: DriveSheetToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_conditional_format_list',
      module: DRIVE_MODULE_ID,
      summary:
        'List the conditional formatting rules on a sheet of an Excel workbook (.xlsx) in Drive, in priority order (1 = highest): type, sqref, stop_if_true, style, formulas, colour scale points, data bar or icon set.',
      auditClass: 'read',
      inputSchema: cfListInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = cfListInput.parse(input)
        const lib = await xlsx()
        const { condFormat } = await rulesLib()
        const { file, editor } = await openBook(await service(), ctx, i.file_id, lib, sheetLive)
        return guarded(lib, () => {
          const info = editor.wb.requireWorksheet(i.sheet)
          return {
            file: { id: file.id, name: file.name },
            sheet: info.name,
            rules: condFormat.cfRulesOf(editor.wb, info.name).map(presentRule),
          }
        })
      },
    },
    {
      name: 'drive.sheet_conditional_format_set',
      module: DRIVE_MODULE_ID,
      summary:
        'Add, edit or reorder a conditional formatting rule on a sheet of an Excel workbook (.xlsx) in Drive. Omit priority to add a new rule on top (priority 1); pass priority to update range/rule or reorder with move_to. Supports cellIs, expression, colorScale, dataBar, iconSet, top10, aboveAverage, duplicateValues, uniqueValues, text rules, blanks, errors and timePeriod. Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof cfSetInput>, output: unknown) => {
        const name = nameOf(output)
        if (!name) return `Tried to update conditional formatting in file ${input.file_id} in Drive`
        if (input.priority !== undefined) {
          return input.move_to !== undefined && !input.rule && !input.range
            ? `Reordered conditional format rule ${input.priority} in ${input.sheet} of ${name} in Drive`
            : `Updated conditional format rule ${input.priority} in ${input.sheet} of ${name} in Drive`
        }
        return `Added a conditional format rule on ${input.range ?? input.sheet} in ${input.sheet} of ${name} in Drive`
      },
      inputSchema: cfSetInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = cfSetInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { condFormat } = await rulesLib()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () => {
          if (i.priority === undefined) {
            if (!i.range || !i.rule)
              throw new DriveError(
                'invalid',
                'Give range and rule to add a conditional format rule.',
              )
            editor.apply({
              op: 'cf_add',
              sheet: i.sheet,
              range: i.range,
              rule: toCfRuleInput(i.rule),
            })
            return
          }
          if (!i.range && !i.rule && i.move_to === undefined)
            throw new DriveError('invalid', 'Give range, rule or move_to when updating a rule.')
          if (i.range !== undefined || i.rule !== undefined) {
            editor.apply({
              op: 'cf_update',
              sheet: i.sheet,
              priority: i.priority,
              ...(i.range !== undefined ? { range: i.range } : {}),
              ...(i.rule !== undefined ? { rule: toCfRuleInput(i.rule) } : {}),
            })
          }
          if (i.move_to !== undefined) {
            editor.apply({ op: 'cf_move', sheet: i.sheet, priority: i.priority, to: i.move_to })
          }
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const info = editor.wb.requireWorksheet(i.sheet)
        return {
          ...saved,
          sheet: info.name,
          rules: condFormat.cfRulesOf(editor.wb, info.name).map(presentRule),
        }
      },
    },
    {
      name: 'drive.sheet_conditional_format_delete',
      module: DRIVE_MODULE_ID,
      summary:
        'Delete a conditional formatting rule by priority, or clear conditional formatting from a range (or null for the whole sheet), in an Excel workbook (.xlsx) in Drive. Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof cfDeleteInput>, output: unknown) => {
        const name = nameOf(output)
        if (!name) return `Tried to remove conditional formatting in file ${input.file_id} in Drive`
        if (input.priority !== undefined)
          return `Deleted conditional format rule ${input.priority} in ${input.sheet} of ${name} in Drive`
        return input.range
          ? `Cleared conditional formatting from ${input.range} in ${input.sheet} of ${name} in Drive`
          : `Cleared all conditional formatting in ${input.sheet} of ${name} in Drive`
      },
      inputSchema: cfDeleteInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = cfDeleteInput.parse(input)
        const hasPriority = i.priority !== undefined
        const hasRange = i.range !== undefined
        if (hasPriority === hasRange)
          throw new DriveError(
            'invalid',
            'Give priority or range (not both) to remove conditional formatting.',
          )
        const drive = await service()
        const lib = await xlsx()
        const { condFormat } = await rulesLib()
        const { file, editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () => {
          if (hasPriority) editor.apply({ op: 'cf_delete', sheet: i.sheet, priority: i.priority! })
          else editor.apply({ op: 'cf_clear', sheet: i.sheet, range: i.range ?? null })
        })
        const saved = editor.changed()
          ? await save(drive, ctx, i.file_id, editor, base)
          : { file: { id: file.id, name: file.name }, revision: null }
        const info = editor.wb.requireWorksheet(i.sheet)
        return {
          ...saved,
          sheet: info.name,
          rules: condFormat.cfRulesOf(editor.wb, info.name).map(presentRule),
        }
      },
    },
    {
      name: 'drive.sheet_validation_set',
      module: DRIVE_MODULE_ID,
      summary:
        'Set a data validation rule on a range of an Excel workbook (.xlsx) in Drive: list (inline items or range/name formula1), whole, decimal, date, time, textLength or custom, with optional input prompt and stop/warning/information error alert. Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof validationSetInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Set ${input.type} validation on ${input.range} in ${input.sheet} of ${name} in Drive`
          : `Tried to set data validation in file ${input.file_id} in Drive`
      },
      inputSchema: validationSetInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = validationSetInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const rule: ValidationRule = {
          type: i.type,
          ...(i.operator !== undefined ? { operator: i.operator } : {}),
          ...(i.formula1 !== undefined ? { formula1: i.formula1 } : {}),
          ...(i.formula2 !== undefined ? { formula2: i.formula2 } : {}),
          ...(i.items !== undefined ? { items: i.items } : {}),
          ...(i.allow_blank !== undefined ? { allowBlank: i.allow_blank } : {}),
          ...(i.dropdown !== undefined ? { dropdown: i.dropdown } : {}),
          ...(i.input_title !== undefined ? { inputTitle: i.input_title } : {}),
          ...(i.input_message !== undefined ? { inputMessage: i.input_message } : {}),
          ...(i.error_style !== undefined ? { errorStyle: i.error_style } : {}),
          ...(i.error_title !== undefined ? { errorTitle: i.error_title } : {}),
          ...(i.error_message !== undefined ? { errorMessage: i.error_message } : {}),
          ...(i.show_input !== undefined ? { showInput: i.show_input } : {}),
          ...(i.show_error !== undefined ? { showError: i.show_error } : {}),
        }
        await guarded(lib, () =>
          editor.apply({ op: 'validation_set', sheet: i.sheet, range: i.range, rule }),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const info = editor.wb.requireWorksheet(i.sheet)
        return {
          ...saved,
          sheet: info.name,
          validations: lib.validation.validationsOf(editor.wb, info.name).map(presentValidation),
        }
      },
    },
    {
      name: 'drive.sheet_validation_clear',
      module: DRIVE_MODULE_ID,
      summary:
        'Clear data validation rules from a range of an Excel workbook (.xlsx) in Drive (parts of rules outside the range stay intact). Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof validationClearInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Cleared data validation from ${input.range} in ${input.sheet} of ${name} in Drive`
          : `Tried to clear data validation in file ${input.file_id} in Drive`
      },
      inputSchema: validationClearInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = validationClearInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { file, editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () =>
          editor.apply({ op: 'validation_clear', sheet: i.sheet, range: i.range }),
        )
        const saved = editor.changed()
          ? await save(drive, ctx, i.file_id, editor, base)
          : { file: { id: file.id, name: file.name }, revision: null }
        const info = editor.wb.requireWorksheet(i.sheet)
        return {
          ...saved,
          sheet: info.name,
          validations: lib.validation.validationsOf(editor.wb, info.name).map(presentValidation),
        }
      },
    },
    {
      name: 'drive.sheet_hyperlink_set',
      module: DRIVE_MODULE_ID,
      summary:
        'Add or update a hyperlink on a cell or range in an Excel workbook (.xlsx) in Drive: web/mailto/ftp URL or an in-workbook place (Sheet2!A1, #Sheet2!A1 or a defined name), with optional tooltip and display text. Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof hyperlinkSetInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Set a hyperlink on ${input.range} in ${input.sheet} of ${name} in Drive`
          : `Tried to set a hyperlink in file ${input.file_id} in Drive`
      },
      inputSchema: hyperlinkSetInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = hyperlinkSetInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () =>
          editor.apply({
            op: 'hyperlink_set',
            sheet: i.sheet,
            range: i.range,
            target: i.target,
            ...(i.tooltip !== undefined ? { tooltip: i.tooltip } : {}),
            ...(i.text !== undefined ? { text: i.text } : {}),
          }),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const info = editor.wb.requireWorksheet(i.sheet)
        return {
          ...saved,
          sheet: info.name,
          hyperlinks: lib.hyperlinks.hyperlinksOf(editor.wb, info.name).map((h) => ({
            ref: h.ref,
            target: h.target.kind === 'url' ? h.target.url : h.target.location,
            kind: h.target.kind,
            tooltip: h.tooltip,
            display: h.display,
          })),
        }
      },
    },
    {
      name: 'drive.sheet_hyperlink_remove',
      module: DRIVE_MODULE_ID,
      summary:
        'Remove hyperlinks from a cell or range in an Excel workbook (.xlsx) in Drive (keeps the cell text and look). Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof hyperlinkRemoveInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Removed hyperlink from ${input.range} in ${input.sheet} of ${name} in Drive`
          : `Tried to remove hyperlink in file ${input.file_id} in Drive`
      },
      inputSchema: hyperlinkRemoveInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = hyperlinkRemoveInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { file, editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () =>
          editor.apply({ op: 'hyperlink_remove', sheet: i.sheet, range: i.range }),
        )
        const saved = editor.changed()
          ? await save(drive, ctx, i.file_id, editor, base)
          : { file: { id: file.id, name: file.name }, revision: null }
        const info = editor.wb.requireWorksheet(i.sheet)
        return {
          ...saved,
          sheet: info.name,
          hyperlinks: lib.hyperlinks.hyperlinksOf(editor.wb, info.name).map((h) => ({
            ref: h.ref,
            target: h.target.kind === 'url' ? h.target.url : h.target.location,
            kind: h.target.kind,
            tooltip: h.tooltip,
            display: h.display,
          })),
        }
      },
    },
    {
      name: 'drive.sheet_names_list',
      module: DRIVE_MODULE_ID,
      summary:
        'List the defined names (Name Manager) of an Excel workbook (.xlsx) in Drive: name, scope (null = workbook, else sheet name), refers_to formula, comment, hidden and built_in.',
      auditClass: 'read',
      inputSchema: namesListInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = namesListInput.parse(input)
        const lib = await xlsx()
        const { names } = await rulesLib()
        const { file, editor } = await openBook(await service(), ctx, i.file_id, lib, sheetLive)
        return guarded(lib, () => ({
          file: { id: file.id, name: file.name },
          names: names.listNames(editor.wb).map((n) => ({
            name: n.name,
            scope: n.scope,
            refers_to: n.refersTo,
            comment: n.comment,
            hidden: n.hidden,
            built_in: n.builtIn,
          })),
        }))
      },
    },
    {
      name: 'drive.sheet_names_set',
      module: DRIVE_MODULE_ID,
      summary:
        'Add or update a defined name in an Excel workbook (.xlsx) in Drive (workbook-wide or scoped to a sheet). Renaming rewrites formulas across cells, conditional formats, validations and other names. Built-in _xlnm.* names cannot be changed here. Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof namesSetInput>, output: unknown) => {
        const name = nameOf(output)
        if (!name)
          return `Tried to set defined name ${input.name} in file ${input.file_id} in Drive`
        return input.new_name
          ? `Renamed defined name ${input.name} to ${input.new_name} in ${name} in Drive`
          : `Set defined name ${input.name} in ${name} in Drive`
      },
      inputSchema: namesSetInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = namesSetInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { names } = await rulesLib()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () => {
          const scope = i.scope ? editor.wb.requireSheet(i.scope).name : null
          const key = i.name.trim().toLowerCase()
          const existing = names
            .listNames(editor.wb)
            .find((n) => n.name.toLowerCase() === key && n.scope === scope)
          if (i.new_name !== undefined || existing) {
            if (i.new_name === undefined && i.refers_to === undefined && i.comment === undefined)
              throw new DriveError(
                'invalid',
                'Give new_name, refers_to or comment to update the name.',
              )
            editor.apply({
              op: 'name_update',
              name: i.name,
              scope,
              ...(i.new_name !== undefined ? { newName: i.new_name } : {}),
              ...(i.refers_to !== undefined ? { refersTo: i.refers_to } : {}),
              ...(i.comment !== undefined ? { comment: i.comment } : {}),
            })
          } else {
            if (i.refers_to === undefined)
              throw new DriveError(
                'invalid',
                'Give refers_to (like =Sheet1!$A$1:$A$10) to add a name.',
              )
            editor.apply({
              op: 'name_add',
              name: i.name,
              refersTo: i.refers_to,
              scope,
              ...(i.comment !== undefined ? { comment: i.comment } : {}),
            })
          }
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return {
          ...saved,
          names: names.listNames(editor.wb).map((n) => ({
            name: n.name,
            scope: n.scope,
            refers_to: n.refersTo,
            comment: n.comment,
            hidden: n.hidden,
            built_in: n.builtIn,
          })),
        }
      },
    },
    {
      name: 'drive.sheet_names_delete',
      module: DRIVE_MODULE_ID,
      summary:
        'Delete a defined name from an Excel workbook (.xlsx) in Drive (formulas that used it show #NAME?; built-in _xlnm.* names cannot be deleted here). Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof namesDeleteInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Deleted defined name ${input.name} from ${name} in Drive`
          : `Tried to delete defined name ${input.name} from file ${input.file_id} in Drive`
      },
      inputSchema: namesDeleteInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = namesDeleteInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { names } = await rulesLib()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () =>
          editor.apply({
            op: 'name_delete',
            name: i.name,
            ...(i.scope !== undefined ? { scope: i.scope } : {}),
          }),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return {
          ...saved,
          names: names.listNames(editor.wb).map((n) => ({
            name: n.name,
            scope: n.scope,
            refers_to: n.refersTo,
            comment: n.comment,
            hidden: n.hidden,
            built_in: n.builtIn,
          })),
        }
      },
    },
    {
      name: 'drive.sheet_protect',
      module: DRIVE_MODULE_ID,
      summary:
        'Protect or unprotect a sheet (with optional SHA-512 password and allowed actions), protect or unprotect workbook structure, or lock/unlock/hide cells in an Excel workbook (.xlsx) in Drive. Saved as a new revision; passwords are hashed and never stored or returned.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof protectInput>, output: unknown) => {
        const name = nameOf(output)
        if (!name) return `Tried to change protection on file ${input.file_id} in Drive`
        switch (input.action) {
          case 'protect_sheet':
            return `Protected sheet ${input.sheet ?? ''} in ${name} in Drive`
          case 'unprotect_sheet':
            return `Unprotected sheet ${input.sheet ?? ''} in ${name} in Drive`
          case 'protect_workbook':
            return `Protected workbook structure of ${name} in Drive`
          case 'unprotect_workbook':
            return `Unprotected workbook structure of ${name} in Drive`
          case 'set_cell_protection':
            return `Updated cell protection on ${input.range ?? ''} in ${input.sheet ?? ''} of ${name} in Drive`
        }
      },
      inputSchema: protectInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = protectInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { file, editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () => {
          let op: SheetOp
          if (i.action === 'protect_sheet') {
            if (!i.sheet) throw new DriveError('invalid', 'Give sheet to protect a worksheet.')
            const allow: Partial<Record<SheetAllow, boolean>> = {}
            for (const [k, v] of Object.entries(i.allow ?? {}))
              if (v !== undefined) allow[ALLOW_KEY[k as keyof typeof ALLOW_KEY]] = v
            op = {
              op: 'protect_sheet',
              sheet: i.sheet,
              ...(i.password !== undefined ? { password: i.password } : {}),
              ...(Object.keys(allow).length > 0 ? { allow } : {}),
            }
          } else if (i.action === 'unprotect_sheet') {
            if (!i.sheet) throw new DriveError('invalid', 'Give sheet to unprotect a worksheet.')
            op = {
              op: 'unprotect_sheet',
              sheet: i.sheet,
              ...(i.password !== undefined ? { password: i.password } : {}),
            }
          } else if (i.action === 'protect_workbook') {
            op = {
              op: 'protect_workbook',
              ...(i.password !== undefined ? { password: i.password } : {}),
            }
          } else if (i.action === 'unprotect_workbook') {
            op = {
              op: 'unprotect_workbook',
              ...(i.password !== undefined ? { password: i.password } : {}),
            }
          } else {
            if (!i.sheet || !i.range)
              throw new DriveError('invalid', 'Give sheet and range for set_cell_protection.')
            op = {
              op: 'set_cell_protection',
              sheet: i.sheet,
              range: i.range,
              ...(i.locked !== undefined ? { locked: i.locked } : {}),
              ...(i.hidden !== undefined ? { hidden: i.hidden } : {}),
            }
          }
          editor.apply(op)
        })
        const saved = editor.changed()
          ? await save(drive, ctx, i.file_id, editor, base)
          : { file: { id: file.id, name: file.name }, revision: null }
        const wbProt = lib.protection.workbookProtectionOf(editor.wb)
        const sheetProt = i.sheet ? lib.protection.sheetProtectionOf(editor.wb, i.sheet) : null
        return {
          ...saved,
          ...(i.sheet
            ? {
                sheet: editor.wb.requireWorksheet(i.sheet).name,
                sheet_protection: sheetProt
                  ? {
                      allow: sheetProt.allow,
                      has_password: sheetProt.hasPassword,
                    }
                  : null,
              }
            : {}),
          workbook_protection: wbProt
            ? {
                structure: wbProt.structure,
                windows: wbProt.windows,
                has_password: wbProt.hasPassword,
              }
            : null,
        }
      },
    },
  ]
}
