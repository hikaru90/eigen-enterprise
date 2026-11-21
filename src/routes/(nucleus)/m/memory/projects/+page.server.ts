import type { PageServerLoad } from './$types'
import { listTeamProjects } from '$lib/server/memory/team-projects'
import { defaultRoadmapStore } from '../../../../../../modules/orchestrator/roadmap/store'
import { summarizeRoadmap } from '../../../../../../modules/orchestrator/roadmap/summary'
import { loadTimelinePageData } from '../../../../timeline/timeline-page-load'

/**
 * Memory → Projects: the Roadmap system project pinned first (for every
 * member — it is the company's), then this person's own projects (Mine) or
 * the projects colleagues share with everyone (Team, read-only —
 * plan/shared-memory-voice-agent-tools.md §1).
 */
export const load: PageServerLoad = async (event) => {
  const timeline = await loadTimelinePageData(event)
  event.depends('memory:roadmap')
  const scope =
    event.url.searchParams.get('scope') === 'team' ? ('team' as const) : ('mine' as const)
  const teamProjects = scope === 'team' ? await listTeamProjects(timeline.user.id) : []
  return {
    ...timeline,
    roadmap: summarizeRoadmap(await defaultRoadmapStore().list()),
    scope,
    teamProjects,
  }
}
