import type { RequestHandler } from './$types'
import { driveJson, driveService, requestActor } from '$lib/server/drive'

/**
 * POST: Make an editable .xlsx copy of an .xls/.ods shown read-only (=
 * drive.make_xlsx_copy): a new file next to the original; the answer names
 * what the copy does not keep.
 */
export const POST: RequestHandler = (event) =>
  driveJson(event, async () =>
    (await driveService()).makeXlsxCopy(requestActor(event), event.params.id),
  )
