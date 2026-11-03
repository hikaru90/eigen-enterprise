import type { RequestHandler } from './$types'
import { driveJson, driveService, grantsBody, itemType, parseBody, requestActor } from '$lib/server/drive'

/** The Share dialog: the item's direct grants (manage only) and replacing them. */
export const GET: RequestHandler = (event) =>
  driveJson(async () => ({ grants: await (await driveService()).getGrants(requestActor(event), itemType(event.params.type), event.params.id) }))

export const PUT: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const type = itemType(event.params.type)
    const b = await parseBody(event.request, grantsBody)
    return { grants: await (await driveService()).setGrants(actor, type, event.params.id, b.grants) }
  })
