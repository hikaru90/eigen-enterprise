import type { RequestHandler } from './$types'
import { batchBody, driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

/** POST { items }: the Trash selection's Delete forever (confirmed in the UI) — needs manage per item (drive.delete_forever_many). */
export const POST: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, batchBody)
    return (await driveService()).deleteForeverMany(actor, b.items)
  })
