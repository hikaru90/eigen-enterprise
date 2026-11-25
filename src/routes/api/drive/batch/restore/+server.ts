import type { RequestHandler } from './$types'
import { batchBody, driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

/** POST { items }: the Trash selection's Restore — per item, like the row's Restore (drive.restore_many). */
export const POST: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, batchBody)
    return (await driveService()).restoreMany(actor, b.items)
  })
