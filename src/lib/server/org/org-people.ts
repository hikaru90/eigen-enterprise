import type { OrgPerson } from '$lib/coworkers/org-tree'
import type { CoworkerView, OrgChartEntry } from '$lib/server/coworkers/service'
import type { PersonRunner } from './person-run'

/**
 * Everyone's seat for the org chart pages: org.chart, with each co-worker's
 * model from coworkers.list (both read tools every member may call).
 */
export async function loadOrgPeople(run: PersonRunner, user: { id: string }): Promise<OrgPerson[]> {
  const [chart, list] = await Promise.all([
    run<{ people: OrgChartEntry[] }>(user, 'org.chart', {}),
    run<{ coworkers: CoworkerView[] }>(user, 'coworkers.list', {}),
  ])
  const modelOf = new Map(list.coworkers.map((c) => [c.id, c.modelId]))
  return chart.people.map((p) => ({ ...p, modelId: p.kind === 'coworker' ? (modelOf.get(p.id) ?? null) : null }))
}
