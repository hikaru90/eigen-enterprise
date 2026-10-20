import type { LayoutServerLoad } from './$types'
import { foundingCompanyName } from '$lib/server/overview/sources'
import { buildShellNav, type ShellData } from '$lib/shell/nav'
import { bootstrapKernel } from '../../../modules/index'

/**
 * The app shell's data for signed-in pages: the company name and the nav,
 * built from the module registry plus activation state. Signed-out visitors
 * get no shell (their pages redirect to /login on their own).
 */
export const load: LayoutServerLoad = async ({ locals }): Promise<{ shell: ShellData | null }> => {
  if (!locals.user) return { shell: null }
  const kernel = bootstrapKernel()
  return {
    shell: {
      companyName: await foundingCompanyName(),
      nav: buildShellNav(kernel.modules.list(), await kernel.activations.list()),
    },
  }
}
