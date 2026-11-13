import type { HubContribution, HubContributionInput, HubInstall, HubStore } from './store'

const key = (installId: string, remoteId: string) => `${installId}/${remoteId}`

/** The fields an install sends: an upsert with all of them equal writes nothing. */
export const HUB_COMPARED_FIELDS = [
  'summary',
  'language',
  'kind',
  'area',
  'status',
  'score',
  'appVersion',
  'createdDay',
  'shippedDay',
] as const satisfies readonly (keyof HubContributionInput)[]

export function sameContribution(a: HubContributionInput, b: HubContributionInput): boolean {
  return HUB_COMPARED_FIELDS.every((f) => a[f] === b[f])
}

/** Highest score first, then most recently updated (the order both stores list in). */
export function boardOrder(a: HubContribution, b: HubContribution): number {
  return b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime()
}

/** In-memory HubStore for unit tests (same semantics as the DB store). */
export function memoryHubStore(): HubStore & {
  installs: Map<string, HubInstall>
  rows: Map<string, HubContribution>
  signatures: Map<string, Date>
  counts: Map<string, number>
} {
  const installs = new Map<string, HubInstall>()
  const rows = new Map<string, HubContribution>()
  const signatures = new Map<string, Date>()
  const counts = new Map<string, number>()
  return {
    installs,
    rows,
    signatures,
    counts,
    async getInstall(id) {
      const i = installs.get(id)
      return i ? { ...i } : null
    },
    async insertInstall({ installId, publicKey, appVersion, at }) {
      if (installs.has(installId)) return false
      installs.set(installId, { installId, publicKey, appVersion, registeredAt: at, lastSeenAt: at, revokedAt: null })
      return true
    },
    async touchInstall(id, at, appVersion) {
      const i = installs.get(id)
      if (!i) throw new Error(`hub install ${id} not found`)
      installs.set(id, { ...i, lastSeenAt: at, appVersion: appVersion ?? i.appVersion })
    },
    async revokeInstall(id, at) {
      const i = installs.get(id)
      if (!i) return null
      const out = { ...i, revokedAt: i.revokedAt ?? at }
      installs.set(id, out)
      return { ...out }
    },
    async deleteInstall(id) {
      if (!installs.delete(id)) return false
      for (const [k, r] of rows) if (r.installId === id) rows.delete(k)
      return true
    },
    async upsert(row, at) {
      if (!installs.has(row.installId)) throw new Error(`hub install ${row.installId} not found`)
      const k = key(row.installId, row.remoteId)
      const old = rows.get(k)
      if (!old) {
        rows.set(k, { ...row, updatedAt: at, receivedAt: at })
        return 'created'
      }
      if (sameContribution(old, row)) return 'unchanged'
      rows.set(k, { ...row, updatedAt: at, receivedAt: old.receivedAt })
      return 'updated'
    },
    async deleteContribution(installId, remoteId) {
      return rows.delete(key(installId, remoteId))
    },
    async get(installId, remoteId) {
      const r = rows.get(key(installId, remoteId))
      return r ? { ...r } : null
    },
    async list(statuses) {
      return [...rows.values()].filter((r) => statuses.includes(r.status)).sort(boardOrder).map((r) => ({ ...r }))
    },
    async claimSignature(hash, at, pruneBefore) {
      for (const [h, seen] of signatures) if (seen < pruneBefore) signatures.delete(h)
      if (signatures.has(hash)) return false
      signatures.set(hash, at)
      return true
    },
    async countRequest(installId, hour) {
      for (const k of counts.keys()) if (new Date(k.slice(k.indexOf('@') + 1)) < hour) counts.delete(k)
      const k = `${installId}@${hour.toISOString()}`
      const n = (counts.get(k) ?? 0) + 1
      counts.set(k, n)
      return n
    },
  }
}
