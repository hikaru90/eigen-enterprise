import type { LayoutServerLoad } from './$types'
import { userCapabilities } from '$lib/server/auth/require-capability'
import { appKernel } from '$lib/server/boot'
import { speechToTextReadiness } from '$lib/server/llm/speech-readiness'
import { companyIdentity } from '$lib/server/overview/sources'
import { buildShellNav, type ShellData } from '$lib/shell/nav'

/**
 * The app shell's data for signed-in pages: the company's name and logo
 * (Settings → Company), what this person may open and do (one capability set
 * from the same rules the route guards use — every menu, tab and card
 * decides from it), the nav (the module registry plus activation state,
 * without pages they can't open) and whether dictation can work (every text
 * box with a mic reads it, so the mic says what is missing instead of failing
 * after a recording). Signed-out visitors get no shell (their pages redirect
 * to /login on their own).
 */
export const load: LayoutServerLoad = async ({ locals }): Promise<{ shell: ShellData | null }> => {
  if (!locals.user) return { shell: null }
  const kernel = await appKernel()
  const [identity, capabilities] = await Promise.all([companyIdentity(), userCapabilities(locals.user.id)])
  return {
    shell: {
      companyName: identity.name,
      companyLogo: identity.logo?.url ?? null,
      capabilities,
      nav: buildShellNav(kernel.modules.list(), await kernel.activations.list(), capabilities),
      dictation: await speechToTextReadiness(locals.user.id),
    },
  }
}
