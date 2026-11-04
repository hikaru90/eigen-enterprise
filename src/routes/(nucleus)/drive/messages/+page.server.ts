import type { PageServerLoad } from './$types'
import { driveService, drivePage, requestActor } from '$lib/server/drive'

/** Messages: one folder per conversation whose attachments you can open (Messages keeps them in Drive). */
export const load: PageServerLoad = async (event) => {
  const actor = requestActor(event)
  const drive = await driveService()
  return drivePage(async () => {
    const items = await drive.messagesFolders(actor)
    return { items, describe: await drive.describeItems(actor, items) }
  })
}
