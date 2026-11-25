import type { RequestHandler } from './$types'
import { batchMoveBody, driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

/** POST { items, folderId }: the selection bar's Move to… — moves each item the person may edit; says why for the rest (drive.move_many). */
export const POST: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, batchMoveBody)
    return (await driveService()).moveMany(actor, b.items, b.folderId)
  })
