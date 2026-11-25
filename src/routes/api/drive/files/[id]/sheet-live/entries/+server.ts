import type { RequestHandler } from './$types'
import { driveJson, requestActor } from '$lib/server/drive'
import { parseAfter } from '$lib/server/sheet-live/http'
import { sheetLiveListening } from '$lib/server/sheet-live/live'

export const GET: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    const after = parseAfter(event.url.searchParams.get('after'))
    const entries = await (await sheetLiveListening()).entriesAfter(actor, event.params.id, after)
    return { entries }
  })
