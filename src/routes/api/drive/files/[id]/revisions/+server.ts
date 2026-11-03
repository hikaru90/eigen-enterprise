import type { RequestHandler } from './$types'
import { z } from 'zod'
import { driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

const body = z.object({ restore: z.string().min(1), session: z.string().min(8).max(100).optional() }).strict()

/** GET the revisions (newest first); POST { restore: <revisionId> } saves that revision again as the newest. */
export const GET: RequestHandler = (event) =>
  driveJson(async () => ({ revisions: await (await driveService()).listRevisions(requestActor(event), event.params.id) }))

export const POST: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, body)
    return (await driveService()).restoreRevision(actor, event.params.id, b.restore, b.session)
  })
