import type { RequestHandler } from './$types'
import { driveAppTool } from '$lib/server/drive-apps'

/** DELETE → drive.app_stop by preview id: "Another app is running: <name>" → Stop it. */
export const DELETE: RequestHandler = (event) => driveAppTool(event, 'drive.app_stop', { preview_id: event.params.previewId })
