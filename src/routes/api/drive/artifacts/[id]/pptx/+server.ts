import type { RequestHandler } from './$types'
import { driveJson, driveService, requestActor } from '$lib/server/drive'
import { exportArtifactPptx } from '../../../../../../../modules/drive/artifact-tools'

/** POST: Export PowerPoint — saves `<name>.pptx` next to the deck (= artifacts.export_pptx). */
export const POST: RequestHandler = async (event) =>
  driveJson(event, async () => exportArtifactPptx(await driveService(), requestActor(event), event.params.id, undefined))
