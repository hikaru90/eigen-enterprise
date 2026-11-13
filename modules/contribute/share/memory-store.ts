import type { OutboxEntry, ShareSettings, ShareStore } from './store'

/**
 * In-memory ShareStore for unit tests (same semantics as the DB store). The
 * state is shared with memoryContributeStore, which creates and dirties rows
 * the way the DB store does inside its transactions.
 */

export type MemoryShareState = {
  settings: ShareSettings
  outbox: Map<string, OutboxEntry>
  /** The clock vote changes are stamped with (the DB uses now()). */
  now: () => Date
}

export function memoryShareState(enabled = true, now: () => Date = () => new Date()): MemoryShareState {
  return {
    now,
    settings: { enabled, installId: null, registeredAt: null, revokedAt: null, lastError: null, updatedAt: new Date(0) },
    outbox: new Map(),
  }
}

const newEntry = (id: string, state: OutboxEntry['state'], at: Date): OutboxEntry => ({
  contributionId: id,
  state,
  summary: null,
  language: null,
  lastSentHash: null,
  attempts: 0,
  nextAttemptAt: at,
  lastError: null,
  sentAt: null,
  updatedAt: at,
})

/** A new proposal: a pending row, only while sharing is on. */
export function memoryEnqueue(s: MemoryShareState, id: string, at: Date): void {
  if (s.settings.enabled) s.outbox.set(id, newEntry(id, 'pending', at))
}

/** A status/note/vote change: a sent row is due again; any live row's claim token moves. */
export function memoryMarkDirty(s: MemoryShareState, id: string, at: Date): void {
  const e = s.outbox.get(id)
  if (!e || (e.state !== 'pending' && e.state !== 'scrubbed' && e.state !== 'sent')) return
  s.outbox.set(id, e.state === 'sent' ? { ...e, state: 'scrubbed', nextAttemptAt: at, updatedAt: at } : { ...e, updatedAt: at })
}

const due = (e: OutboxEntry, now: Date) =>
  e.nextAttemptAt.getTime() <= now.getTime() &&
  (e.state === 'pending' || e.state === 'scrubbed' || (e.state === 'excluded' && e.lastSentHash !== null))

export function memoryShareStore(s: MemoryShareState): ShareStore {
  const patch = (id: string, p: Partial<OutboxEntry>) => {
    const e = s.outbox.get(id)
    if (!e) throw new Error(`contribute_outbox ${id} not found`)
    s.outbox.set(id, { ...e, ...p })
    return e
  }
  const settings = (p: Partial<ShareSettings>) => {
    s.settings = { ...s.settings, ...p }
  }
  return {
    async settings() {
      return { ...s.settings }
    },
    async setEnabled(enabled, at) {
      settings({ enabled, updatedAt: at })
    },
    async setInstallId(installId, at) {
      settings({ installId, updatedAt: at })
    },
    async setRegistered(registeredAt, at) {
      settings({ registeredAt, ...(registeredAt ? { lastError: null } : {}), updatedAt: at })
    },
    async setRevoked(revokedAt, error) {
      settings({ revokedAt, lastError: error, updatedAt: revokedAt })
    },
    async setLastError(lastError, at) {
      settings({ lastError, updatedAt: at })
    },
    async entry(id) {
      const e = s.outbox.get(id)
      return e ? { ...e } : null
    },
    async entries(ids) {
      const out = new Map<string, OutboxEntry>()
      for (const id of ids) {
        const e = s.outbox.get(id)
        if (e) out.set(id, { ...e })
      }
      return out
    },
    async counts() {
      const all = [...s.outbox.values()]
      const withError = all.filter((e) => e.lastError).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
      return {
        waiting: all.filter((e) => e.state === 'pending' || e.state === 'scrubbed').length,
        sent: all.filter((e) => e.state === 'sent').length,
        failed: all.filter((e) => e.state === 'failed').length,
        withdrawing: all.filter((e) => e.state === 'excluded' && e.lastSentHash !== null).length,
        lastError: withError ? { message: withError.lastError!, at: withError.updatedAt } : null,
      }
    },
    async exclude(id, at) {
      const e = s.outbox.get(id) ?? newEntry(id, 'excluded', at)
      s.outbox.set(id, { ...e, state: 'excluded', nextAttemptAt: at, attempts: 0, lastError: null, updatedAt: at })
    },
    async hasDue(now) {
      return [...s.outbox.values()].some((e) => due(e, now))
    },
    async claimDue(now, limit, leaseUntil) {
      const rows = [...s.outbox.values()]
        .filter((e) => due(e, now))
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, limit)
      return rows.map((e) => {
        const claimed = { ...e, nextAttemptAt: leaseUntil, updatedAt: now }
        s.outbox.set(e.contributionId, claimed)
        return { ...claimed }
      })
    },
    async saveScrub(id, { summary, language }) {
      const e = s.outbox.get(id)
      if (!e) throw new Error(`contribute_outbox ${id} not found`)
      patch(id, { summary, language, ...(e.state === 'pending' ? { state: 'scrubbed' as const } : {}) })
    },
    async markSent(id, hash, at, claimToken) {
      const e = s.outbox.get(id)
      if (!e) return
      const untouched = e.updatedAt.getTime() === claimToken.getTime() && (e.state === 'pending' || e.state === 'scrubbed')
      patch(id, {
        lastSentHash: hash,
        sentAt: at,
        attempts: 0,
        lastError: null,
        ...(untouched ? { state: 'sent' as const, updatedAt: at } : { nextAttemptAt: at }),
      })
    },
    async markRetry(id, lastError, attempts, nextAttemptAt, at) {
      if (s.outbox.has(id)) patch(id, { lastError, attempts, nextAttemptAt, updatedAt: at })
    },
    async markFailed(id, lastError, at) {
      const e = s.outbox.get(id)
      if (!e) return
      patch(id, { lastError, updatedAt: at, ...(e.state === 'pending' || e.state === 'scrubbed' ? { state: 'failed' as const } : {}) })
    },
    async markWithdrawn(id, at) {
      if (s.outbox.has(id)) patch(id, { lastSentHash: null, sentAt: null, attempts: 0, lastError: null, updatedAt: at })
    },
    async withdrawAll(at) {
      for (const [id, e] of s.outbox) {
        s.outbox.set(id, { ...e, state: 'excluded', lastSentHash: null, sentAt: null, attempts: 0, lastError: null, nextAttemptAt: at, updatedAt: at })
      }
    },
  }
}
