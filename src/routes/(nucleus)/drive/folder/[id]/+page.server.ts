import type { PageServerLoad } from './$types'
import { driveService, drivePage, requestActor } from '$lib/server/drive'

/** A folder: its contents, the path to it, and what you may do there (access-checked; no view → 404). */
export const load: PageServerLoad = async (event) => {
  const actor = requestActor(event)
  const drive = await driveService()
  const q = event.url.searchParams.get('q')?.trim() ?? ''
  return drivePage(async () => {
    const listing = await drive.listFolder(actor, event.params.id)
    const results = q ? await drive.search(actor, q) : null
    return {
      listing,
      root: listing.root,
      query: q,
      results,
      describe: await drive.describeItems(actor, results ?? listing.items),
    }
  })
}
