import type { RequestHandler } from './$types'
import { driveJson, driveService, requestActor } from '$lib/server/drive'
import { exportArtifactPdf } from '../../../../../../../modules/drive/artifact-tools'

/** POST: Export PDF — saves `<name>.pdf` next to the artifact (= artifacts.export_pdf). */
export const POST: RequestHandler = async (event) =>
  driveJson(event, async () => exportArtifactPdf(await driveService(), requestActor(event), event.params.id, undefined))
