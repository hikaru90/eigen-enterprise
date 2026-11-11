import type { CallContextKind, CallPerson, CallRecord, CallsDirectory, CallsStore, InsertResult } from './store'
import { isLive, sameRecord } from './state'

/**
 * In-memory CallsStore with the Postgres store's semantics that matter: one
 * live call per DM/channel (the partial unique index), per-call serialized
 * mutations, and a change hook standing in for pg_notify.
 */
export class MemoryCallsStore implements CallsStore {
  readonly records = new Map<string, CallRecord>()
  /** Called after every stored change (like NOTIFY ee_calls, payload = call id). */
  onChange: ((callId: string) => void) | null = null
  private lock: Promise<unknown> = Promise.resolve()

  private copy(rec: CallRecord): CallRecord {
    return structuredClone(rec)
  }

  private serialized<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  async insert(rec: CallRecord): Promise<InsertResult> {
    // A turn of the event loop first, like a real round trip: concurrent starts interleave.
    await Promise.resolve()
    return this.serialized(() => {
      for (const r of this.records.values()) {
        if (rec.call.roomName === r.call.roomName || rec.call.id === r.call.id) throw new Error('duplicate call id/room')
      }
      if (rec.call.contextId !== null) {
        const clash = [...this.records.values()].find(
          (r) => r.call.contextKind === rec.call.contextKind && r.call.contextId === rec.call.contextId && isLive(r.call.state),
        )
        if (clash) return { ok: false as const, existing: this.copy(clash) }
      }
      this.records.set(rec.call.id, this.copy(rec))
      this.onChange?.(rec.call.id)
      return { ok: true as const }
    })
  }

  async get(id: string) {
    const r = this.records.get(id)
    return r ? this.copy(r) : null
  }

  async getByRoom(roomName: string) {
    const r = [...this.records.values()].find((x) => x.call.roomName === roomName)
    return r ? this.copy(r) : null
  }

  async liveForContext(kind: CallContextKind, contextId: string) {
    const r = [...this.records.values()].find((x) => x.call.contextKind === kind && x.call.contextId === contextId && isLive(x.call.state))
    return r ? this.copy(r) : null
  }

  private newestFirst(rs: CallRecord[], limit: number) {
    return rs
      .sort((a, b) => b.call.startedAt.getTime() - a.call.startedAt.getTime())
      .slice(0, limit)
      .map((r) => this.copy(r))
  }

  async listForUser(userId: string, limit: number) {
    return this.newestFirst([...this.records.values()].filter((r) => r.participants.some((p) => p.userId === userId)), limit)
  }

  async listStartedBy(principalId: string, limit: number) {
    return this.newestFirst([...this.records.values()].filter((r) => r.call.startedBy === principalId), limit)
  }

  async liveForUser(userId: string) {
    return this.newestFirst(
      [...this.records.values()].filter((r) => isLive(r.call.state) && r.participants.some((p) => p.userId === userId)),
      1000,
    )
  }

  async ringingStartedBefore(cutoff: Date) {
    return [...this.records.values()]
      .filter((r) => r.call.state === 'ringing' && r.call.startedAt.getTime() <= cutoff.getTime())
      .map((r) => r.call.id)
  }

  mutate(id: string, change: (rec: CallRecord) => CallRecord) {
    return this.serialized(() => {
      const current = this.records.get(id)
      if (!current) return null
      const before = this.copy(current)
      const after = change(this.copy(current))
      if (!sameRecord(before, after)) {
        this.records.set(id, this.copy(after))
        this.onChange?.(id)
      }
      return { before, after }
    })
  }
}

export class MemoryCallsDirectory implements CallsDirectory {
  readonly roles = new Map<string, 'owner' | 'admin' | 'member'>()

  constructor(readonly people: CallPerson[]) {
    for (const p of people) this.roles.set(p.id, 'member')
  }

  async listPeople() {
    return this.people
  }

  async role(userId: string) {
    return this.roles.get(userId) ?? null
  }
}
