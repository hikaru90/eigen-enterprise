import type { CoworkerProfileRow, CoworkerStore, OrgMember, OrgPositionRow } from './service'

/** In-memory CoworkerStore (tests): people are given; co-workers are added through insertCoworker. */
export function memoryCoworkerStore(people: OrgMember[] = []): CoworkerStore & {
  users: Map<string, OrgMember>
  positions: Map<string, OrgPositionRow>
  profiles: Map<string, CoworkerProfileRow>
} {
  const users = new Map(people.map((p) => [p.id, { ...p }]))
  const positions = new Map<string, OrgPositionRow>()
  const profiles = new Map<string, CoworkerProfileRow>()
  const s = {
    users,
    positions,
    profiles,
    async listMembers() {
      return [...users.values()].filter((u) => !profiles.get(u.id)?.removedAt)
    },
    async listPositions() {
      return [...positions.values()].map((p) => ({ ...p, accountabilities: [...p.accountabilities] }))
    },
    async listProfiles() {
      return [...profiles.values()].map((p) => ({ ...p }))
    },
    async coworkerUser(userId: string) {
      const u = users.get(userId)
      return u && u.kind === 'coworker' ? { id: u.id, name: u.name, email: u.email } : null
    },
    async slugTaken(slug: string) {
      return [...profiles.values()].some((p) => p.slug === slug)
    },
    async insertCoworker(input: Parameters<CoworkerStore['insertCoworker']>[0]) {
      if (users.has(input.user.id)) throw new Error(`user ${input.user.id} exists`)
      users.set(input.user.id, { ...input.user, role: 'member', kind: 'coworker' })
      profiles.set(input.user.id, { ...input.profile })
      positions.set(input.user.id, { ...input.position })
    },
    async updateCoworker(userId: string, patch: Parameters<CoworkerStore['updateCoworker']>[1]) {
      const u = users.get(userId)
      const p = profiles.get(userId)
      if (!u || !p) throw new Error(`no co-worker ${userId}`)
      if (patch.name !== undefined) users.set(userId, { ...u, name: patch.name })
      if (patch.profile) profiles.set(userId, { ...p, ...patch.profile })
      if (patch.position) positions.set(userId, { ...patch.position })
    },
    async upsertPosition(row: OrgPositionRow) {
      positions.set(row.userId, { ...row })
    },
    async markRemoved(userId: string, at: Date, by: string, reparentTo: string | null) {
      const p = profiles.get(userId)
      if (!p) throw new Error(`no co-worker ${userId}`)
      profiles.set(userId, { ...p, enabled: false, removedAt: at, removedBy: by, updatedAt: at })
      for (const [id, pos] of positions) {
        if (pos.reportsToUserId === userId) positions.set(id, { ...pos, reportsToUserId: reparentTo, updatedAt: at, updatedBy: by })
      }
    },
    async transaction<T>(fn: (store: CoworkerStore) => Promise<T>): Promise<T> {
      return fn(s)
    },
  }
  return s
}
