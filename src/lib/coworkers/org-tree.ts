/**
 * The org chart as a tree (plan/phase-ai-coworkers.md C5): people and AI
 * co-workers from org.chart, each under the person they report to. Pure and
 * shared by the page load and the tree component.
 */

export type AccountableHumanView = { id: string; name: string; reason: 'chain' | 'owner' }

/** One seat, as org.chart answers it, plus the co-worker's model (coworkers.list) when it is one. */
export type OrgPerson = {
  id: string
  name: string
  kind: 'human' | 'coworker'
  role: 'owner' | 'admin' | 'member'
  title: string | null
  accountabilities: string[]
  reportsToUserId: string | null
  accountableHuman: AccountableHumanView | null
  enabled: boolean | null
  /** Co-workers only: the pool model id it runs on. */
  modelId: string | null
}

export type OrgNode = { person: OrgPerson; reports: OrgNode[] }

const ROLE_ORDER: Record<OrgPerson['role'], number> = { owner: 0, admin: 1, member: 2 }

/** Siblings: the owner first, then people, then co-workers; by name within each. */
function bySeat(a: OrgPerson, b: OrgPerson): number {
  if (a.kind !== b.kind) return a.kind === 'human' ? -1 : 1
  if (a.role !== b.role) return ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
  return a.name.localeCompare(b.name)
}

/**
 * Roots are the seats that report to nobody (or to someone no longer in the
 * chart). org.set_position refuses cycles; should one still reach the page,
 * its first seat becomes a root, so every seat is shown exactly once.
 */
export function buildOrgTree(people: readonly OrgPerson[]): OrgNode[] {
  const byId = new Map(people.map((p) => [p.id, p]))
  const children = new Map<string, OrgPerson[]>()
  for (const p of people) {
    const parent = p.reportsToUserId
    if (parent && parent !== p.id && byId.has(parent)) children.set(parent, [...(children.get(parent) ?? []), p])
  }
  const placed = new Set<string>()
  const grow = (p: OrgPerson): OrgNode => {
    placed.add(p.id)
    const reports = (children.get(p.id) ?? []).filter((c) => !placed.has(c.id)).sort(bySeat)
    return { person: p, reports: reports.map(grow) }
  }
  const roots = people
    .filter((p) => !p.reportsToUserId || p.reportsToUserId === p.id || !byId.has(p.reportsToUserId))
    .sort(bySeat)
    .map(grow)
  for (const p of [...people].sort(bySeat)) if (!placed.has(p.id)) roots.push(grow(p))
  return roots
}

/** The seat's manager's name, or null. */
export function managerName(people: readonly OrgPerson[], person: OrgPerson): string | null {
  if (!person.reportsToUserId) return null
  return people.find((p) => p.id === person.reportsToUserId)?.name ?? null
}

/**
 * The seats `personId` may report to: anyone but themselves and the people
 * below them (that would be a cycle; the tool refuses it too).
 */
export function managerOptions(people: readonly OrgPerson[], personId: string): OrgPerson[] {
  const below = new Set<string>([personId])
  let grew = true
  while (grew) {
    grew = false
    for (const p of people) {
      if (p.reportsToUserId && below.has(p.reportsToUserId) && !below.has(p.id)) {
        below.add(p.id)
        grew = true
      }
    }
  }
  return people.filter((p) => !below.has(p.id)).sort(bySeat)
}

/** Accountabilities typed one per line → the list the tools take (blank lines dropped). */
export function accountabilityLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}
