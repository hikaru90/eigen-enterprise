import type { RequestHandler } from './$types'
import type { SubmitRequest } from '$lib/office/xlsx/collab/protocol'
import { driveJson, parseBody, requestActor } from '$lib/server/drive'
import { submitSchema } from '$lib/server/sheet-live/http'
import { sheetLiveListening } from '$lib/server/sheet-live/live'

export const POST: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    const body = (await parseBody(event.request, submitSchema)) as SubmitRequest
    return (await sheetLiveListening()).submit(actor, event.params.id, body)
  })
