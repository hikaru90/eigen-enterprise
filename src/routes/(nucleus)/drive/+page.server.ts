import type { PageServerLoad } from './$types'
import { driveService, drivePage, requestActor } from '$lib/server/drive'

/** My drive: your top level; ?q= searches every file and folder you can open by name. */
export const load: PageServerLoad = async (event) => {
  const actor = requestActor(event)
  const drive = await driveService()
  const q = event.url.searchParams.get('q')?.trim() ?? ''
  return drivePage(async () => {
    const listing = await drive.listFolder(actor, null)
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
