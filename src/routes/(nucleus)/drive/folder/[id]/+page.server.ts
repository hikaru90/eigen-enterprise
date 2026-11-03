import type { PageServerLoad } from './$types'
import { driveService, drivePage, requestActor } from '$lib/server/drive'

/** A folder: its contents, the path to it, and what you may do there (access-checked; no view → 404). */
export const load: PageServerLoad = async (event) => {
  const actor = requestActor(event)
  const drive = await driveService()
  const q = event.url.searchParams.get('q')?.trim() ?? ''
  return drivePage(async () => ({
    listing: await drive.listFolder(actor, event.params.id),
    query: q,
    results: q ? await drive.search(actor, q) : null,
  }))
}
