import type { PageServerLoad } from './$types'
import { driveService, drivePage, requestActor } from '$lib/server/drive'

/** Drive overview: all accessible top-level items across My drive, Shared with me, Messages and sources; ?q= searches by name, ?origin= selects an origin filter. */
export const load: PageServerLoad = async (event) => {
  const actor = requestActor(event)
  const drive = await driveService()
  const q = event.url.searchParams.get('q')?.trim() ?? ''
  const origin = event.url.searchParams.get('origin')?.trim() || null
  return drivePage(async () => {
    const items = await drive.listOverview(actor)
    const results = q ? await drive.search(actor, q) : null
    return {
      items,
      canEdit: true,
      root: { label: 'Overview', href: '/drive' },
      origin,
      query: q,
      results,
      describe: await drive.describeItems(actor, results ?? items),
    }
  })
}
