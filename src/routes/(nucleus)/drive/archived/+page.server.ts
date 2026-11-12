import type { PageServerLoad } from './$types'
import { driveService, drivePage, requestActor, SUGGEST_DEFAULT_DAYS } from '$lib/server/drive'

/** Archived: what was archived among the items you can open, grouped by the folder each is in. */
export const load: PageServerLoad = async (event) => {
  const actor = requestActor(event)
  const drive = await driveService()
  return drivePage(async () => ({ groups: await drive.archived(actor), suggestDays: SUGGEST_DEFAULT_DAYS }))
}
