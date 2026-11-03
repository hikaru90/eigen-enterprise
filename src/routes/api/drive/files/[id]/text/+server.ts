import type { RequestHandler } from './$types'
import { z } from 'zod'
import { driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

/** `session`: the editor session holding the edit lock (W-6); without it the file must not be locked. */
const body = z.object({ content: z.string(), session: z.string().min(8).max(100).optional() }).strict()

/** GET the text of a text file; PUT new Markdown/CSV text (stored as a revision). */
export const GET: RequestHandler = (event) => driveJson(async () => (await driveService()).readText(requestActor(event), event.params.id))

export const PUT: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, body)
    return (await driveService()).writeText(actor, event.params.id, b.content, b.session)
  })
