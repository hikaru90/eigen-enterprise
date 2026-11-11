import { appKernel } from '$lib/server/boot'
import type { LayoutServerLoad } from './$types'
import { speechToTextReadiness } from '$lib/server/llm/speech-readiness'
import { foundingCompanyName } from '$lib/server/overview/sources'
import { buildShellNav, type ShellData } from '$lib/shell/nav'

/**
 * The app shell's data for signed-in pages: the company name, the nav (built from the
 * module registry plus activation state) and whether dictation can work (every text box
 * with a mic reads it, so the mic says what is missing instead of failing after a recording). Signed-out visitors
 * get no shell (their pages redirect to /login on their own).
 */
export const load: LayoutServerLoad = async ({ locals }): Promise<{ shell: ShellData | null }> => {
  if (!locals.user) return { shell: null }
  const kernel = await appKernel()
  return {
    shell: {
      companyName: await foundingCompanyName(),
      nav: buildShellNav(kernel.modules.list(), await kernel.activations.list()),
      dictation: await speechToTextReadiness(locals.user.id),
    },
  }
}
