import type { RequestHandler } from './$types'
import { z } from 'zod'
import { driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

const body = z.object({ folderId: z.string().min(1).nullable(), kind: z.enum(['md', 'csv']), name: z.string().optional() }).strict()

/** New → Document (.md) / Table (.csv): an empty file. */
export const POST: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, body)
    return (await driveService()).createDocument(actor, b.folderId, b.kind, b.name)
  })
