import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { SubmitRequest } from '$lib/office/xlsx/collab/protocol'
import { submitSchema } from '$lib/server/sheet-live/http'
import type { SheetLive } from '$lib/server/sheet-live/service'
import { DRIVE_MODULE_ID } from './manifest'
import { DRIVE_ROLES, fileId } from './sheet-tools'
import { actorOf } from './tools'

/**
 * drive.sheet_live_* — co-editing an Excel workbook (plan/phase-office-files.md
 * §7.4) as registry actions: the grid's own calls (join the file's live
 * session, read its log, send a batch of changes), so the `ee` CLI and the
 * agent reach what the grid does. For everyday changes the agent uses
 * drive.sheet_write / _structure / _format …, which go through the same log
 * while the file is open.
 */

export type DriveSheetLiveToolDeps = { sheetLive: () => Promise<SheetLive> }

const joinInput = z.object({ file_id: fileId }).strict()
const entriesInput = z
  .object({
    file_id: fileId,
    after: z.number().int().min(0).describe('The last entry already applied (0: from the start of the log)'),
  })
  .strict()
const submitInput = z
  .object({
    file_id: fileId,
    batch: submitSchema.describe(
      '{ clientId, baseSeq (the last entry the changes were made on), changes: [{ opId, body: { kind: "change", ops: [SheetOp…], acceptLosses } | { kind: "revert", of, images } }] }',
    ),
  })
  .strict()

export function createDriveSheetLiveTools({ sheetLive }: DriveSheetLiveToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_live_join',
      module: DRIVE_MODULE_ID,
      summary:
        'Open an Excel workbook’s (.xlsx) live co-editing session (file_id): the saved content it starts from (baseSha256, baseSeq), the changes logged since (entries, in order), the last entry (head), who has it open (peers: name, sheet, selection, whether they can edit) and whether you can edit. Starts the session when nobody has the file open.',
      auditClass: 'read',
      permission: { roles: DRIVE_ROLES },
      inputSchema: joinInput,
      handler: async (ctx, input) => (await sheetLive()).join(actorOf(ctx), joinInput.parse(input).file_id),
    },
    {
      name: 'drive.sheet_live_entries',
      module: DRIVE_MODULE_ID,
      summary:
        'Read an Excel workbook’s (.xlsx) co-editing log after entry `after` (file_id, after): each entry’s number, author, time and change. Refused (conflict) when the file was replaced since that entry — join again.',
      auditClass: 'read',
      permission: { roles: DRIVE_ROLES },
      inputSchema: entriesInput,
      handler: async (ctx, input) => {
        const i = entriesInput.parse(input)
        return { entries: await (await sheetLive()).entriesAfter(actorOf(ctx), i.file_id, i.after) }
      },
    },
    {
      name: 'drive.sheet_live_submit',
      module: DRIVE_MODULE_ID,
      summary:
        'Send a batch of changes to an Excel workbook’s (.xlsx) co-editing session (file_id, batch: clientId, baseSeq, changes) — what the grid sends. The server rewrites the changes past what others logged since baseSeq, logs what still applies (accepted: entry numbers) and names what doesn’t (rejected); resending a batch is harmless. Everyone in the file sees the changes at once; the file is saved as one revision after a pause. state "reload": the file was replaced, join again. For cell, format and structure changes prefer drive.sheet_write / drive.sheet_structure / drive.sheet_format.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof submitInput>) =>
        `Sent ${input.batch.changes.length} change(s) to the live workbook ${input.file_id} in Drive`,
      permission: { roles: DRIVE_ROLES },
      inputSchema: submitInput,
      handler: async (ctx, input) => {
        const i = submitInput.parse(input)
        return (await sheetLive()).submit(actorOf(ctx), i.file_id, i.batch as SubmitRequest)
      },
    },
  ]
}
