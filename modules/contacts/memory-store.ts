import type { ContactFilter, ContactRow, ContactScope, ContactsStore } from './store'

/** In-memory ContactsStore for unit tests (same semantics as the DB store). */
export function memoryContactsStore(): ContactsStore & { rows: Map<string, ContactRow> } {
  const rows = new Map<string, ContactRow>()
  const inScope = (scope: ContactScope, r: ContactRow) => scope.kind === 'all' || r.shared || r.createdBy === scope.userId
  const byName = (a: ContactRow, b: ContactRow) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)
  const matches = (r: ContactRow, f: ContactFilter) => {
    if (f.tag !== undefined && !r.tags.includes(f.tag)) return false
    if (f.query !== undefined) {
      const q = f.query.toLowerCase()
      return r.name.toLowerCase().includes(q) || (r.organisation ?? '').toLowerCase().includes(q)
    }
    return true
  }
  const copy = (r: ContactRow): ContactRow => ({ ...r, channels: r.channels.map((c) => ({ ...c })), tags: [...r.tags] })
  return {
    rows,
    async insert(r) {
      if (rows.has(r.id)) throw new Error(`contact ${r.id} exists`)
      rows.set(r.id, copy(r))
    },
    async get(id) {
      const r = rows.get(id)
      return r ? copy(r) : null
    },
    async list(scope, filter) {
      return [...rows.values()].filter((r) => inScope(scope, r) && matches(r, filter)).sort(byName).map(copy)
    },
    async tags(scope) {
      const all = new Set<string>()
      for (const r of rows.values()) if (inScope(scope, r)) for (const t of r.tags) all.add(t)
      return [...all].sort()
    },
    async followUps(scope, until) {
      return [...rows.values()]
        .filter((r) => inScope(scope, r) && r.nextFollowUpOn !== null && r.nextFollowUpOn <= until)
        .sort((a, b) => a.nextFollowUpOn!.localeCompare(b.nextFollowUpOn!) || byName(a, b))
        .map(copy)
    },
    async update(id, patch) {
      const r = rows.get(id)
      if (!r) throw new Error(`contact ${id} not found`)
      rows.set(id, copy({ ...r, ...patch }))
    },
    async delete(id) {
      rows.delete(id)
    },
  }
}
