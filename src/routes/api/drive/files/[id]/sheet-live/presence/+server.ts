import type { RequestHandler } from './$types'
import { driveJson, parseBody, requestActor } from '$lib/server/drive'
import { presenceSchema } from '$lib/server/sheet-live/http'
import { sheetLiveListening } from '$lib/server/sheet-live/live'

export const POST: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    const body = await parseBody(event.request, presenceSchema)
    await (await sheetLiveListening()).presence(actor, event.params.id, body)
    return { ok: true }
  })
