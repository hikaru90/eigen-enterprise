import type { RequestHandler } from './$types'
import { batchBody, driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

/** POST { items }: the selection bar's Move to trash — per item, like the row's Trash (drive.trash_many). */
export const POST: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, batchBody)
    return (await driveService()).trashMany(actor, b.items)
  })
