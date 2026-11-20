import type { RequestHandler } from './$types'
import { driveAppTool } from '$lib/server/drive-apps'

/**
 * A folder's web app (plan/phase-drive-app-preview.md), through the registry:
 * GET → drive.app_status (marks a running preview seen), POST → drive.app_run
 * (Run and Restart), DELETE → drive.app_stop.
 */
export const GET: RequestHandler = (event) => driveAppTool(event, 'drive.app_status', { folder_id: event.params.id })
export const POST: RequestHandler = (event) => driveAppTool(event, 'drive.app_run', { folder_id: event.params.id })
export const DELETE: RequestHandler = (event) => driveAppTool(event, 'drive.app_stop', { folder_id: event.params.id })
