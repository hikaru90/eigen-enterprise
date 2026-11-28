import type { PersonRunner } from './person-run'
import type { OrgPerson } from '$lib/coworkers/org-tree'
import type { CoworkerView, OrgChartEntry } from '$lib/server/coworkers/service'

/**
 * Everyone's seat for the org chart pages: org.chart, with each co-worker's
 * model from coworkers.list (both read tools every member may call).
 */
export async function loadOrgPeople(run: PersonRunner, user: { id: string }): Promise<OrgPerson[]> {
  const [chart, list] = await Promise.all([
    run<{ people: OrgChartEntry[] }>(user, 'org.chart', {}),
    run<{ coworkers: CoworkerView[] }>(user, 'coworkers.list', {}),
  ])
  const modelOf = new Map(list.coworkers.map((c) => [c.id, c.modelLabel]))
  return chart.people.map((p) => ({
    ...p,
    image: p.image ?? null,
    reportsToUserIds: p.reportsToUserIds ?? (p.reportsToUserId ? [p.reportsToUserId] : []),
    accountableHumans: p.accountableHumans ?? (p.accountableHuman ? [p.accountableHuman] : []),
    modelLabel: p.kind === 'coworker' ? (modelOf.get(p.id) ?? null) : null,
  }))
}
