import type { RequestHandler } from './$types'
import { driveJson, driveService, itemType, requestActor } from '$lib/server/drive'

export const POST: RequestHandler = (event) =>
  driveJson(async () => (await driveService()).restore(requestActor(event), itemType(event.params.type), event.params.id))
