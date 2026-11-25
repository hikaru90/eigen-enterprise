/** Drive for routes: the live service and the HTTP seam (implementation in modules/drive). */
export {
  driveService,
  driveViewSecret,
  mintViewToken,
  readViewToken,
  viewMimeFor,
  VIEW_TOKEN_TTL_MS,
  type ViewScope,
  DriveError,
  UploadConflictError,
  ON_CONFLICT,
  type OnConflict,
  DOCUMENT_KINDS,
  type UploadOutcome,
  LOCK_HEARTBEAT_MS,
  LOCK_TTL_MS,
  type LockView,
  formatBytes,
  type Actor,
  type DriveService,
  type ItemType,
  type ItemView,
} from '../../../modules/drive/index'
export {
  archiveBody,
  batchBody,
  batchMoveBody,
  batchShareBody,
  DRIVE_STATUS,
  drivePage,
  grantsBody,
  itemType,
  parseBody,
  requestActor,
  suggestBody,
} from '../../../modules/drive/http'
export {
  liveSuggestChat,
  SUGGEST_DEFAULT_DAYS,
  suggestArchive,
} from '../../../modules/drive/archive-suggest'
export { renderDriveMarkdown } from '../../../modules/drive/markdown'
export {
  officeKind,
  parseCsv,
  previewKind,
  isRevisioned,
  TEXT_PREVIEW_MAX_BYTES,
  type PreviewKind,
} from '../../../modules/drive/preview'
export { DRIVE_MODULE_ID } from '../../../modules/drive/manifest'

import { json, type RequestEvent } from '@sveltejs/kit'
import type { ErrorReport } from '$lib/errors/agent-report'
import { errorReport } from '$lib/server/errors/report'
import { DRIVE_STATUS, driveErrorBody } from '../../../modules/drive/http'
import { DriveError as DriveFailure } from '../../../modules/drive/index'

/** Next steps per Drive code — exhaustive: a new code without steps is a type error. */
const DRIVE_STEPS: Record<DriveFailure['code'], string[]> = {
  not_found: [
    'The item does not exist or is in the bin for this person: check the id with `ee tool run drive.list` as the same person.',
  ],
  forbidden: [
    'The person lacks access to this item (modules/drive access grants). Change sharing only if the item’s manager asks.',
  ],
  invalid: [
    'Drive refused the input; the sentence names the field. If the page built the request, fix the page; if the person typed it, the sentence tells them what to change.',
  ],
  too_large: [
    'The file is over Drive’s size limit (modules/drive/service.ts); raise it only if the owner asks.',
  ],
  locked: [
    'Someone else holds the edit lock (`holder` in the answer). Wait for it to be released or let the person take it over; never break a lock silently.',
  ],
  unavailable: [
    'A dependency is not set up on this server (no AI provider for the company, or no ee to run an app on). Set it up as the owner directs.',
  ],
  upstream: [
    'A provider Drive depends on failed or answered unreadably: read the cause and the server journal at the time above.',
  ],
  busy: ['Another app preview is running (`running` in the answer); stop it first, then retry.'],
  conflict: [
    'A file of that name is already in the folder (`existing` in the answer). Ask the person whether to replace it (a new revision) or keep both, then upload again with onConflict replace or keep_both.',
    'A save from an editor or tool: the file changed after it was read (another save landed in between). Read the file again and make the change on the newer version.',
  ],
}

/** A DriveError as the browser client reads it: { error, code, holder?, running? } plus the agent report. */
export function driveErrorReport(
  err: DriveFailure,
  ctx: { attempted: string; tool?: string; input?: unknown },
): ErrorReport & Record<string, unknown> {
  const report = errorReport(err, {
    ...ctx,
    plain: () => err.message,
    nextSteps: DRIVE_STEPS[err.code],
  })
  return { ...driveErrorBody(err), error: report.error, agent: { ...report.agent, code: err.code } }
}

/** What a Drive JSON request was, for the agent report: its method and path. */
export const driveAttempted = (event: Pick<RequestEvent, 'request' | 'url'>): string =>
  `Drive request ${event.request.method} ${event.url.pathname}`

/** Runs a Drive JSON API handler: DriveError becomes { error, code, agent } with its status; anything else is a real failure (500). */
export async function driveJson(
  event: Pick<RequestEvent, 'request' | 'url'>,
  run: () => Promise<unknown>,
): Promise<Response> {
  try {
    return json((await run()) ?? { ok: true })
  } catch (err) {
    if (err instanceof DriveFailure)
      return json(driveErrorReport(err, { attempted: driveAttempted(event) }), {
        status: DRIVE_STATUS[err.code],
      })
    throw err
  }
}
