import type { LayoutServerLoad } from './$types'
import { appKernel } from '$lib/server/boot'
import { EMAIL_MODULE_ID } from '../../../../../modules/email/manifest'
import { requireMember } from './access.server'

/**
 * The Email area frame (replaces the generic /m/[moduleId] page for email):
 * status pill from the module activation and whether the viewer may change
 * anything. Each tab reads its own mail state (Senders: connected, not "has a
 * default sender", so eigenEnterprise Mail can add its first sender there).
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  const me = await requireMember(locals)
  const kernel = await appKernel()
  const active = (await kernel.activations.get(EMAIL_MODULE_ID)) === true
  return {
    email: { active, isAdmin: me.isAdmin },
  }
}
