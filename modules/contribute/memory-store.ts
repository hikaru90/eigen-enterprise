import type { ContributeStore, Contribution, ContributionWithVotes } from './store'

/** In-memory ContributeStore for unit tests (same semantics as the DB store). */
export function memoryContributeStore(): ContributeStore & { rows: Map<string, Contribution> } {
  const rows = new Map<string, Contribution>()
  const votes = new Map<string, Map<string, 1 | -1>>()
  const withVotes = (c: Contribution): ContributionWithVotes => {
    const v = new Map(votes.get(c.id) ?? [])
    let score = 0
    for (const d of v.values()) score += d
    return { ...c, votes: v, score }
  }
  return {
    rows,
    async insert(c) {
      if (rows.has(c.id)) throw new Error(`contribution ${c.id} exists`)
      rows.set(c.id, { ...c })
      votes.set(c.id, new Map([[c.authorId, 1]]))
    },
    async get(id) {
      const c = rows.get(id)
      return c ? withVotes(c) : null
    },
    async list(statuses) {
      return [...rows.values()]
        .filter((c) => statuses.includes(c.status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(withVotes)
    },
    async update(id, patch) {
      const c = rows.get(id)
      if (!c) throw new Error(`contribution ${id} not found`)
      rows.set(id, { ...c, ...patch })
    },
    async setVote(id, userId, direction) {
      const v = votes.get(id)
      if (!v) throw new Error(`contribution ${id} not found`)
      if (direction === 0) v.delete(userId)
      else v.set(userId, direction)
    },
  }
}
