import type { RequestHandler } from './$types'
import { z } from 'zod'
import { driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

const body = z.object({ parentId: z.string().min(1).nullable(), name: z.string() }).strict()

/** GET ?parent=<id|empty>: a folder's contents (the Move picker). POST: a new folder. */
export const GET: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const parent = event.url.searchParams.get('parent') || null
    return (await driveService()).listFolder(actor, parent)
  })

export const POST: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, body)
    return (await driveService()).createFolder(actor, b.parentId, b.name)
  })
