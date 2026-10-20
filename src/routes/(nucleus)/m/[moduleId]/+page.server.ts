import { appKernel } from '$lib/server/boot'
import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { moduleOverview } from '$lib/server/overview/overview'
import { humanContext, overviewResultSources } from '$lib/server/overview/sources'
import { bootstrapKernel } from '../../../../../modules/index'

/**
 * /m/[moduleId]: one module's page — header, results (the same read-only
 * sources as /overview) and its settings slot. An inactive module renders as
 * "Not active"; only an id the registry doesn't know is a 404.
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const kernel = await appKernel()
  const manifest = kernel.modules.get(event.params.moduleId)
  // Internal modules (the agent's own machinery) have no owner-facing page.
  if (!manifest || manifest.internal === true) throw error(404, 'No such module')

  const userId = event.locals.user.id
  const isAdmin = await isUserAdmin(userId)
  const active = (await kernel.activations.get(manifest.id)) === true
  const module = await moduleOverview(manifest, active, {
    registry: kernel.registry,
    ctx: humanContext(userId, isAdmin),
    canReadResults: isAdmin,
    resultSources: overviewResultSources(),
  })
  return { module }
}
