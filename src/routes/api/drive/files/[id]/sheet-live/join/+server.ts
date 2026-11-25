import type { RequestHandler } from './$types'
import { driveJson, requestActor } from '$lib/server/drive'
import { sheetLiveListening } from '$lib/server/sheet-live/live'

export const POST: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    return (await sheetLiveListening()).join(actor, event.params.id)
  })
