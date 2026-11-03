import type { RequestHandler } from './$types'
import { driveJson, driveService, requestActor } from '$lib/server/drive'

/** GET one revision's text (view an older version). */
export const GET: RequestHandler = (event) =>
  driveJson(async () =>
    (await driveService()).readRevision(
      requestActor(event),
      event.params.id,
      event.params.revision,
    ),
  )
