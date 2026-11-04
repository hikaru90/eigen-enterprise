import type { LayoutServerLoad } from './$types'
import { appKernel } from '$lib/server/boot'
import { EMAIL_MODULE_ID } from '../../../../../modules/email/manifest'
import { owleryService } from '../../../../../modules/email/owlery/service'
import { requireMember } from './access.server'

/**
 * The Email area frame (replaces the generic /m/[moduleId] page for email):
 * status pill from the module activation, whether Amazon SES is connected,
 * and whether the viewer may change anything.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  const me = await requireMember(locals)
  const kernel = await appKernel()
  const active = (await kernel.activations.get(EMAIL_MODULE_ID)) === true
  return {
    email: { active, configured: await owleryService().isConfigured(), isAdmin: me.isAdmin },
  }
}
