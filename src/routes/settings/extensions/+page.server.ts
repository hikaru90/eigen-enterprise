import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { defaultRoadmapStore } from '../../../../modules/orchestrator/roadmap/store'

/**
 * Extension Roadmap: the company's build log (shipped), work in progress, and
 * planned queue, straight from the extension_roadmap_items table the roadmap
 * module's kernel tools maintain. Read-only here — mutations live in the
 * kernel tool surface (agent + `ee` CLI).
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }

  return {
    items: await defaultRoadmapStore().list(),
  }
}
