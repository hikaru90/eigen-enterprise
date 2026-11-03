import type { PageServerLoad } from './$types'
import { driveService, drivePage, requestActor } from '$lib/server/drive'

/** My drive: your top level; ?q= searches every file and folder you can open by name. */
export const load: PageServerLoad = async (event) => {
  const actor = requestActor(event)
  const drive = await driveService()
  const q = event.url.searchParams.get('q')?.trim() ?? ''
  return drivePage(async () => ({
    listing: await drive.listFolder(actor, null),
    query: q,
    results: q ? await drive.search(actor, q) : null,
  }))
}
