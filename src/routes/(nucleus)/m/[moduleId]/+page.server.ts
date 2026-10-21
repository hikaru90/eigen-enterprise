import type { ActivityResult } from '../../../../../modules/website/activity-tools'
import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { moduleOverview } from '$lib/server/overview/overview'
import { humanContext, overviewResultSources } from '$lib/server/overview/sources'
import { AppUserError } from '../../../../../modules/website/apps/contract'
import { WEBSITE_ACTIVITY_TOOL } from '../../../../../modules/website/manifest'

/** How many activity rows the Website module page's panel shows. */
const ACTIVITY_ITEMS = 10

/**
 * /m/[moduleId]: one module's page — header, results (the same read-only
 * sources as /overview) and its settings slot. An inactive module renders as
 * "Not active"; only an id the registry doesn't know is a 404. The Website
 * module additionally gets its recent activity (the `website-activity` panel
 * slot) — read through the kernel as the signed-in owner, so it is
 * permission-checked and audited like every other website read.
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

  let activity: ActivityResult | null = null
  let activityError: string | null = null
  if (manifest.id === 'website' && active && isAdmin) {
    try {
      activity = (await kernel.registry.execute(
        WEBSITE_ACTIVITY_TOOL,
        { limit: ACTIVITY_ITEMS },
        humanContext(userId, isAdmin),
      )) as ActivityResult
    } catch (err) {
      // The page stays up; the panel states what went wrong, in plain words.
      if (!(err instanceof AppUserError))
        console.error(
          `[website/activity] load failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      activityError =
        err instanceof AppUserError
          ? err.message
          : 'Activity could not be loaded. Try again; if it keeps happening, ask in the chat.'
    }
  }

  return { module, activity, activityError }
}
