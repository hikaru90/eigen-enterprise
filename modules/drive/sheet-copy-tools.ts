import type { DriveService, ItemView } from './service'
import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { DRIVE_MODULE_ID } from './manifest'
import { actorOf } from './tools'

/**
 * drive.make_xlsx_copy — "Make an editable .xlsx copy" of a spreadsheet the
 * Drive shows read-only (Excel 97–2003 .xls, OpenDocument .ods; plan/
 * phase-office-files.md §7): the file converted to an Excel workbook, saved
 * as a new file next to the original (a taken name gets “ (2)”), the
 * original left as it is. The answer names what the copy does not keep.
 */

export type DriveSheetCopyToolDeps = { service: () => Promise<DriveService> }

const DRIVE_ROLES = ['admin', 'member', 'agent']

const input = z
  .object({
    file_id: z.string().min(1).describe('The .xls or .ods file'),
    folder_id: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Where the copy goes: a folder id, null for the top level; omitted: next to the original',
      ),
  })
  .strict()

export type XlsxCopyResult = {
  file: ItemView
  source: { id: string; name: string }
  /** What the copy does not carry over from the original. */
  not_kept: Array<{ feature: string; text: string }>
}

export function createDriveSheetCopyTools({ service }: DriveSheetCopyToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.make_xlsx_copy',
      module: DRIVE_MODULE_ID,
      summary:
        'Make an editable Excel (.xlsx) copy of a spreadsheet Drive shows read-only — an Excel 97–2003 workbook (.xls) or an OpenDocument spreadsheet (.ods) — next to the original (file_id; folder_id to put it elsewhere). The original stays as it is. Sheets, values, formulas, number formats, merged cells and column widths are kept; the answer lists what is not (cell formatting, charts and pictures, macros …). Edit the copy with drive.sheet_write / drive.sheet_structure.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (i: z.infer<typeof input>, output: unknown) => {
        const out = output as Partial<XlsxCopyResult> | undefined
        return out?.file?.name && out.source?.name
          ? `Made an editable copy ${out.file.name} of ${out.source.name} in Drive`
          : `Tried to make an editable .xlsx copy of file ${i.file_id} in Drive`
      },
      inputSchema: input,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, raw): Promise<XlsxCopyResult> => {
        const i = input.parse(raw)
        const [drive, { CONVERSION_LOSS_TEXT }] = await Promise.all([
          service(),
          import('$lib/office/xlsx/convert'),
        ])
        const out = await drive.makeXlsxCopy(actorOf(ctx), i.file_id, i.folder_id)
        return {
          file: out.file,
          source: { id: out.source.id, name: out.source.name },
          not_kept: out.notKept.map((feature) => ({
            feature,
            text: CONVERSION_LOSS_TEXT[feature],
          })),
        }
      },
    },
  ]
}
