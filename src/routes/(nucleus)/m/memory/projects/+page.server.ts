import type { PageServerLoad } from './$types'
import { defaultRoadmapStore } from '../../../../../../modules/orchestrator/roadmap/store'
import { summarizeRoadmap } from '../../../../../../modules/orchestrator/roadmap/summary'
import { loadTimelinePageData } from '../../../../timeline/timeline-page-load'

/**
 * Memory → Projects: the Roadmap system project pinned first (for every
 * member — it is the company's), then this person's own projects.
 */
export const load: PageServerLoad = async (event) => {
  const timeline = await loadTimelinePageData(event)
  event.depends('memory:roadmap')
  return { ...timeline, roadmap: summarizeRoadmap(await defaultRoadmapStore().list()) }
}
