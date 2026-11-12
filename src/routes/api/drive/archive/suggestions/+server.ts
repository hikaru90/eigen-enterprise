import type { RequestHandler } from './$types'
import { driveJson, driveService, liveSuggestChat, parseBody, requestActor, suggestArchive, suggestBody } from '$lib/server/drive'

/**
 * POST { olderThanDays }: the AI's suggestions of what to archive among the
 * files the person can edit that haven't changed that long. Archives nothing.
 * No AI provider → 503 with a plain sentence; the provider failing → 502.
 */
export const POST: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    const b = await parseBody(event.request, suggestBody)
    return suggestArchive({ drive: await driveService(), chat: liveSuggestChat }, { actor, olderThanDays: b.olderThanDays })
  })
