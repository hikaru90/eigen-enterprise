import type { RequestHandler } from './$types'
import { driveJson, driveService, itemType, requestActor } from '$lib/server/drive'

/** POST archives the item (it leaves the normal views, nothing moves); DELETE unarchives it. Edit access either way. */
export const POST: RequestHandler = (event) =>
  driveJson(async () => (await driveService()).archive(requestActor(event), itemType(event.params.type), event.params.id))

export const DELETE: RequestHandler = (event) =>
  driveJson(async () => (await driveService()).unarchive(requestActor(event), itemType(event.params.type), event.params.id))
