import type { LayoutServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { userCapabilities } from '$lib/server/auth/require-capability'
import { appKernel } from '$lib/server/boot'
import { DRIVE_MODULE_ID, driveService, formatBytes, requestActor } from '$lib/server/drive'
import { reposService } from '../../../../modules/repos/live'
import { REPOS_MODULE_ID } from '../../../../modules/repos/manifest'

/**
 * The Drive area (D1): one header with My drive · Shared with me · Trash and
 * the storage the company's files take on disk; plus one section per
 * read-only source root the person can open (e.g. GitHub), by its name. Drive is a system module; its
 * status comes from the activation the kernel gates its tools on.
 * `github` (Drive → GitHub, the repos settings): only for people who may
 * connect repos (repos.manage) while the GitHub repos plugin is registered —
 * with how many repos are connected, for the button's label; null otherwise.
 */
export const load: LayoutServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const kernel = await appKernel()
  const manifest = kernel.modules.get(DRIVE_MODULE_ID)
  if (!manifest) throw error(404, 'No such module')
  const active = (await kernel.activations.get(DRIVE_MODULE_ID)) === true
  const drive = await driveService()
  const capabilities = await userCapabilities(event.locals.user.id)
  const github =
    capabilities['repos.manage'] && kernel.modules.get(REPOS_MODULE_ID)
      ? { connectedRepos: (await reposService().tokens()).reduce((n, t) => n + t.repos.length, 0) }
      : null
  return {
    github,
    drive: { name: manifest.name, active, storageUsed: formatBytes(await drive.storageBytes()) },
    sources: await drive.sourceRoots(requestActor(event)),
  }
}
