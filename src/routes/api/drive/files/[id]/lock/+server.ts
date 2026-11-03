import type { RequestHandler } from './$types'
import { z } from 'zod'
import { DriveError, driveJson, driveService, parseBody, requestActor } from '$lib/server/drive'

/**
 * The edit lock of a Markdown/CSV file (W-6). GET: who is editing (view
 * access). POST { session, takeover? }: open for editing — held, or locked
 * by someone (takeover takes it). PUT { session }: heartbeat — held, or
 * locked when someone took over. DELETE ?session=: release.
 */
const session = z.string().min(8).max(100)
const acquire = z.object({ session, takeover: z.boolean().optional() }).strict()
const beat = z.object({ session }).strict()

export const GET: RequestHandler = (event) =>
  driveJson(async () => (await driveService()).lockStatus(requestActor(event), event.params.id))

export const POST: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, acquire)
    return (await driveService()).acquireLock(actor, event.params.id, b.session, {
      takeover: b.takeover,
    })
  })

export const PUT: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, beat)
    return (await driveService()).heartbeatLock(actor, event.params.id, b.session)
  })

export const DELETE: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const s = session.safeParse(event.url.searchParams.get('session'))
    if (!s.success)
      throw new DriveError('invalid', 'session: which editor session to release is required.')
    await (await driveService()).releaseLock(actor, event.params.id, s.data)
    return { ok: true }
  })
