import type { RequestHandler } from './$types'
import { requestActor } from '$lib/server/drive'
import { sheetLiveStreamResponse } from '$lib/server/sheet-live/http'
import { sheetLiveListening } from '$lib/server/sheet-live/live'

export const GET: RequestHandler = async (event) => {
  const actor = requestActor(event)
  return sheetLiveStreamResponse(event, await sheetLiveListening(), actor, event.params.id)
}
