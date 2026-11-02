import type { LayoutServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { appKernel } from '$lib/server/boot'
import { WEBSITE_MODULE_ID } from '../../../../../modules/website/manifest'

/**
 * The Website module page frame: its status pill comes from the same
 * activation the kernel gates the module's tools on (like Memory and Email).
 */
export const load: LayoutServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const kernel = await appKernel()
  const active = (await kernel.activations.get(WEBSITE_MODULE_ID)) === true
  return { website: { active } }
}
