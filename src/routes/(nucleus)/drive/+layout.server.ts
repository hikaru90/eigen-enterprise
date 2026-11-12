import type { LayoutServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { appKernel } from '$lib/server/boot'
import { DRIVE_MODULE_ID, driveService, formatBytes, requestActor } from '$lib/server/drive'

/**
 * The Drive area (D1): one header with My drive · Shared with me · Trash and
 * the storage the company's files take on disk; plus one section per
 * read-only source root the person can open (e.g. GitHub), by its name. Drive is a system module; its
 * status comes from the activation the kernel gates its tools on.
 */
export const load: LayoutServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const kernel = await appKernel()
  const manifest = kernel.modules.get(DRIVE_MODULE_ID)
  if (!manifest) throw error(404, 'No such module')
  const active = (await kernel.activations.get(DRIVE_MODULE_ID)) === true
  const drive = await driveService()
  return {
    drive: { name: manifest.name, active, storageUsed: formatBytes(await drive.storageBytes()) },
    sources: await drive.sourceRoots(requestActor(event)),
  }
}
