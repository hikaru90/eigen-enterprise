import type { RequestHandler } from './$types'
import { batchShareBody, driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

/** POST { items, grants }: the selection bar's Share — adds the grants to each item the person manages, never removes any (drive.share_many). */
export const POST: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, batchShareBody)
    return (await driveService()).shareMany(actor, b.items, b.grants)
  })
