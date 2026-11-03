import type { RequestHandler } from './$types'
import { z } from 'zod'
import { DriveError, driveJson, driveService, itemType, parseBody, requestActor } from '$lib/server/drive'

const patch = z.union([z.object({ name: z.string() }).strict(), z.object({ folderId: z.string().min(1).nullable() }).strict()])

/** PATCH { name } renames, { folderId } moves. DELETE moves to the trash; ?forever=1 deletes a trashed item for good. */
export const PATCH: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const type = itemType(event.params.type)
    const b = await parseBody(event.request, patch)
    const drive = await driveService()
    return 'name' in b ? drive.rename(actor, type, event.params.id, b.name) : drive.move(actor, type, event.params.id, b.folderId)
  })

export const DELETE: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const type = itemType(event.params.type)
    const forever = event.url.searchParams.get('forever')
    if (forever !== null && forever !== '1') throw new DriveError('invalid', 'forever must be 1 when given.')
    const drive = await driveService()
    if (forever === '1') await drive.deleteForever(actor, type, event.params.id)
    else await drive.moveToTrash(actor, type, event.params.id)
    return { ok: true }
  })
