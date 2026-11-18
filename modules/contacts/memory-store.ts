import type {
  ContactFilter,
  ContactRow,
  ContactScope,
  ContactsStore,
  LogEntryRow,
  NextUpCache,
  NextUpEntry,
  ShareRow,
  StoredDefaults,
} from './store'
import type { ContactVisibility } from './types'

/**
 * In-memory ContactsStore for unit tests (same semantics as the DB store).
 * `groups` stands in for Members › Groups (id → name and members), read at
 * query time like the DB store's join on member_group_member.
 */
export function memoryContactsStore(): ContactsStore & {
  rows: Map<string, ContactRow>
  log: LogEntryRow[]
  shareRows: ShareRow[]
  groups: Map<string, { name: string; members: Set<string> }>
  personDefaults: Map<string, ContactVisibility>
  companyDefault: { value: ContactVisibility | null }
} {
  const rows = new Map<string, ContactRow>()
  const log: LogEntryRow[] = []
  const shareRows: ShareRow[] = []
  const groups = new Map<string, { name: string; members: Set<string> }>()
  const personDefaults = new Map<string, ContactVisibility>()
  const companyDefault = { value: null as ContactVisibility | null }
  const sharedWithPerson = (r: ContactRow, userId: string) =>
    shareRows.some(
      (s) =>
        s.contactId === r.id &&
        ((s.kind === 'user' && s.subjectId === userId) || (s.kind === 'group' && groups.get(s.subjectId)?.members.has(userId) === true)),
    )
  const inScope = (scope: ContactScope, r: ContactRow) =>
    scope.kind === 'all' || r.shared || r.createdBy === scope.userId || sharedWithPerson(r, scope.userId)
  const byName = (a: ContactRow, b: ContactRow) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)
  const matches = (r: ContactRow, f: ContactFilter) => {
    if (f.ids !== undefined && !f.ids.includes(r.id)) return false
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
    log,
    shareRows,
    groups,
    personDefaults,
    companyDefault,
    async insert(r) {
      if (rows.has(r.id)) throw new Error(`contact ${r.id} exists`)
      rows.set(r.id, copy(r))
    },
    async insertMany(list) {
      const ids = new Set<string>()
      for (const r of list) {
        if (rows.has(r.id) || ids.has(r.id)) throw new Error(`contact ${r.id} exists`)
        ids.add(r.id)
      }
      for (const r of list) rows.set(r.id, copy(r))
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
      for (let i = log.length - 1; i >= 0; i--) if (log[i]!.contactId === id) log.splice(i, 1)
      for (let i = shareRows.length - 1; i >= 0; i--) if (shareRows[i]!.contactId === id) shareRows.splice(i, 1)
    },
    async shares(ids) {
      return shareRows.filter((s) => ids.includes(s.contactId)).map((s) => ({ ...s }))
    },
    async applySharing(ids, change, _grantedBy, at) {
      for (const id of ids) if (!rows.has(id)) throw new Error(`contact ${id} not found`)
      for (const id of ids) {
        const r = rows.get(id)!
        if (change.kind === 'private') {
          rows.set(id, { ...r, shared: false, updatedAt: at })
          for (let i = shareRows.length - 1; i >= 0; i--) if (shareRows[i]!.contactId === id) shareRows.splice(i, 1)
          continue
        }
        if (change.team) rows.set(id, { ...r, shared: true, updatedAt: at })
        const add = [
          ...change.userIds.map((subjectId) => ({
            contactId: id,
            kind: 'user' as const,
            subjectId,
          })),
          ...change.groupIds.map((subjectId) => ({
            contactId: id,
            kind: 'group' as const,
            subjectId,
          })),
        ]
        for (const s of add) {
          if (!shareRows.some((x) => x.contactId === s.contactId && x.kind === s.kind && x.subjectId === s.subjectId)) shareRows.push(s)
        }
        if (add.length > 0) rows.set(id, { ...rows.get(id)!, updatedAt: at })
      }
    },
    async defaults(userId): Promise<StoredDefaults> {
      return {
        person: userId === null ? null : (personDefaults.get(userId) ?? null),
        company: companyDefault.value,
      }
    },
    async setPersonDefault(userId, visibility) {
      if (visibility === null) personDefaults.delete(userId)
      else personDefaults.set(userId, visibility)
    },
    async setCompanyDefault(visibility) {
      companyDefault.value = visibility
    },
    async recordLog(entry, patch) {
      const r = rows.get(entry.contactId)
      if (!r) throw new Error(`contact ${entry.contactId} not found`)
      log.push({ ...entry })
      rows.set(r.id, copy({ ...r, ...patch }))
    },
    async logEntries(contactId) {
      return log
        .filter((e) => e.contactId === contactId)
        .sort((a, b) => b.on.localeCompare(a.on) || b.createdAt.getTime() - a.createdAt.getTime())
        .map((e) => ({ ...e }))
    },
  }
}

/** In-memory NextUpCache for unit tests. */
export function memoryNextUpCache(): NextUpCache & { entries: Map<string, NextUpEntry> } {
  const entries = new Map<string, NextUpEntry>()
  return {
    entries,
    async get(userId) {
      const e = entries.get(userId)
      return e ? structuredClone(e) : null
    },
    async put(entry) {
      entries.set(entry.userId, structuredClone(entry))
    },
  }
}
