import type { RequestHandler } from './$types'
import { driveJson, driveService, requestActor } from '$lib/server/drive'

/** People and groups the Share dialog can name (signed-in members only). */
export const GET: RequestHandler = (event) =>
  driveJson(async () => {
    requestActor(event)
    return (await driveService()).shareTargets()
  })
