import type { RequestHandler } from './$types'
import { driveJson, driveService, requestActor } from '$lib/server/drive'
import { driveViewUrl } from '$lib/server/drive-view'
import { artifactViewFor } from '../../../../../../modules/drive/artifact-tools'

/**
 * GET: what the assistant's artifact panel shows — the artifact's kind and a
 * fresh sandboxed view address (= artifacts.read with view_url, as this person).
 */
export const GET: RequestHandler = async (event) => {
  const actor = requestActor(event)
  if (actor.kind !== 'user') throw new Error('requestActor returned a non-person actor')
  return driveJson(event, async () => artifactViewFor(await driveService(), actor.userId, event.params.id, async (s) => driveViewUrl(s)))
}
