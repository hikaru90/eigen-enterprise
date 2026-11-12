import type { RequestHandler } from './$types'
import { archiveBody, driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

/** POST { items }: archives each item the person may edit (the suggestions they confirmed); says why for the rest. */
export const POST: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, archiveBody)
    return (await driveService()).archiveMany(actor, b.items)
  })
