import type { PageServerLoad } from './$types'
import { driveService, drivePage, requestActor } from '$lib/server/drive'

/** Shared with me: what other people shared with you (the top-most shared item, not each file inside). */
export const load: PageServerLoad = async (event) => {
  const actor = requestActor(event)
  const drive = await driveService()
  return drivePage(async () => ({ items: await drive.sharedWithMe(actor) }))
}
