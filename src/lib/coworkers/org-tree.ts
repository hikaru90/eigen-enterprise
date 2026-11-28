/**
 * The org chart as a tree (plan/phase-ai-coworkers.md C5): people and AI
 * co-workers from org.chart, each under the person they report to (primary
 * manager places the seat in the tree; secondary managers appear as badges).
 * Pure and shared by the page load and the tree component.
 */

export type AccountableHumanView = { id: string; name: string; reason: 'chain' | 'owner' }

/** One seat, as org.chart answers it, plus the co-worker's model (coworkers.list) when it is one. */
export type OrgPerson = {
  id: string
  name: string
  image?: string | null
  kind: 'human' | 'coworker'
  role: 'owner' | 'admin' | 'member'
  title: string | null
  accountabilities: string[]
  reportsToUserId: string | null
  reportsToUserIds?: string[]
  accountableHuman: AccountableHumanView | null
  accountableHumans?: AccountableHumanView[]
  enabled: boolean | null
  /** Co-workers only: what its model shows as ("eigenInference" there, else the pool model id); null for a human. */
  modelLabel: string | null
}

export type OrgNode = { person: OrgPerson; reports: OrgNode[] }

const ROLE_ORDER: Record<OrgPerson['role'], number> = { owner: 0, admin: 1, member: 2 }

/** Siblings: the owner first, then people, then co-workers; by name within each. */
function bySeat(a: OrgPerson, b: OrgPerson): number {
  if (a.kind !== b.kind) return a.kind === 'human' ? -1 : 1
  if (a.role !== b.role) return ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
  return a.name.localeCompare(b.name)
}

/** Ordered manager user ids for a seat (multi-manager aware, falling back to single reportsToUserId). */
export function managerIdsOf(person: Pick<OrgPerson, 'reportsToUserId' | 'reportsToUserIds'>): string[] {
  if (person.reportsToUserIds && person.reportsToUserIds.length > 0) return person.reportsToUserIds
  return person.reportsToUserId ? [person.reportsToUserId] : []
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
    const parent = managerIdsOf(p)[0] ?? null
    if (parent && parent !== p.id && byId.has(parent)) children.set(parent, [...(children.get(parent) ?? []), p])
  }
  const placed = new Set<string>()
  const grow = (p: OrgPerson): OrgNode => {
    placed.add(p.id)
    const reports = (children.get(p.id) ?? []).filter((c) => !placed.has(c.id)).sort(bySeat)
    return { person: p, reports: reports.map(grow) }
  }
  const roots = people
    .filter((p) => {
      const parent = managerIdsOf(p)[0] ?? null
      return !parent || parent === p.id || !byId.has(parent)
    })
    .sort(bySeat)
    .map(grow)
  for (const p of [...people].sort(bySeat)) if (!placed.has(p.id)) roots.push(grow(p))
  return roots
}

/** Ordered names of everyone `person` reports to. */
export function managerNames(people: readonly OrgPerson[], person: OrgPerson): string[] {
  const byId = new Map(people.map((p) => [p.id, p.name]))
  return managerIdsOf(person)
    .map((id) => byId.get(id))
    .filter((name): name is string => Boolean(name))
}

/** The seat's primary manager's name, or null. */
export function managerName(people: readonly OrgPerson[], person: OrgPerson): string | null {
  return managerNames(people, person)[0] ?? null
}

/**
 * The seats `personId` may report to: anyone but themselves and the people
 * below them along any reporting branch (that would be a cycle; the tool refuses it too).
 */
export function managerOptions(people: readonly OrgPerson[], personId: string): OrgPerson[] {
  const below = new Set<string>([personId])
  let grew = true
  while (grew) {
    grew = false
    for (const p of people) {
      if (managerIdsOf(p).some((id) => below.has(id)) && !below.has(p.id)) {
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
