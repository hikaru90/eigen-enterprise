import type { TraceBatch, TraceCursor, TraceSettings, TraceSource, TraceStore } from './store'
import { memoryVerdictCache } from './value-kind'

/** In-memory TraceStore for unit tests (db-store.ts is the real one; db-store.pg.spec.ts checks they agree). */
export function memoryTraceStore(salt = 'test-salt'): TraceStore & { batches: Map<string, TraceBatch>; cursors: Map<TraceSource, TraceCursor> } {
  let s: TraceSettings | null = null
  const batches = new Map<string, TraceBatch>()
  const cursors = new Map<TraceSource, TraceCursor>()
  const settings = (): TraceSettings => (s ??= { enabled: true, salt, lastSentAt: null, lastError: null, updatedBy: null, updatedAt: new Date(0) })
  const patch = (id: string, p: Partial<TraceBatch>) => {
    const b = batches.get(id)
    if (b) batches.set(id, { ...b, ...p })
  }
  return {
    batches,
    cursors,
    async settings() {
      return { ...settings() }
    },
    async setEnabled(enabled, by, at) {
      s = { ...settings(), enabled, updatedBy: by, updatedAt: at }
    },
    async setSent(at) {
      s = { ...settings(), lastSentAt: at, lastError: null }
    },
    async setLastError(error, at) {
      s = { ...settings(), lastError: error, updatedAt: at }
    },
    async cursor(source, now) {
      if (!cursors.has(source)) cursors.set(source, { at: now, id: '' })
      return { ...cursors.get(source)! }
    },
    async createBatch(batch, next) {
      batches.set(batch.id, structuredClone(batch))
      for (const [k, v] of Object.entries(next)) cursors.set(k as TraceSource, v!)
    },
    async dueBatches(now, limit) {
      return [...batches.values()]
        .filter((b) => b.state === 'pending' && b.nextAttemptAt <= now)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit)
    },
    async markSent(id, at) {
      patch(id, { state: 'sent', sentAt: at, lastError: null })
    },
    async markRetry(id, error, attempts, next) {
      patch(id, { lastError: error, attempts, nextAttemptAt: next })
    },
    async markFailed(id, error) {
      patch(id, { state: 'failed', lastError: error })
    },
    async markWithdrawn(id, at) {
      const ids = [...batches.values()].filter((b) => b.state === 'sent' && (id === null || b.id === id)).map((b) => b.id)
      for (const i of ids) patch(i, { state: 'withdrawn', withdrawnAt: at })
      return ids
    },
    async listBatches(limit) {
      return [...batches.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit)
    },
    async getBatch(id) {
      return batches.get(id) ?? null
    },
    verdicts: memoryVerdictCache(),
  }
}
