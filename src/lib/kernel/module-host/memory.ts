import type { KernelEvent } from '../events'
import type {
  DataFile,
  EventCursor,
  EventCursorStore,
  EventFeed,
  ModuleDataRepo,
  ModulePrincipalStore,
  ModuleRecord,
  ModuleStore,
  PublishedVersion,
  SharingAcceptance,
  SharingStore,
} from './types'

/**
 * In-memory implementations of the module host's stores (unit specs and the
 * core-api snapshot, which composes the kernel without a database).
 */

const clone = <T>(value: T): T => structuredClone(value)

export class InMemoryModuleStore implements ModuleStore {
  private readonly records = new Map<string, ModuleRecord>()
  private readonly published: PublishedVersion[] = []

  async get(id: string): Promise<ModuleRecord | null> {
    const r = this.records.get(id)
    return r ? clone(r) : null
  }
  async list(): Promise<ModuleRecord[]> {
    return [...this.records.values()].map(clone).sort((a, b) => (a.id < b.id ? -1 : 1))
  }
  async create(record: ModuleRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error(`module ${record.id} exists already`)
    this.records.set(record.id, clone(record))
  }
  async put(record: ModuleRecord): Promise<void> {
    if (!this.records.has(record.id)) throw new Error(`module ${record.id} does not exist`)
    this.records.set(record.id, clone(record))
  }
  async remove(id: string): Promise<void> {
    this.records.delete(id)
  }
  async versions(id: string): Promise<PublishedVersion[]> {
    return this.published
      .filter((v) => v.moduleId === id)
      .map(clone)
      .reverse()
  }
  async version(id: string, commit: string): Promise<PublishedVersion | null> {
    const v = this.published.find((p) => p.moduleId === id && p.commit === commit)
    return v ? clone(v) : null
  }
  async addVersion(version: PublishedVersion): Promise<void> {
    if (await this.version(version.moduleId, version.commit)) {
      throw new Error(`${version.moduleId}@${version.commit} is published already`)
    }
    this.published.push(clone(version))
  }
}

export class InMemorySharingStore implements SharingStore {
  private accepted: SharingAcceptance | null = null
  async get(): Promise<SharingAcceptance | null> {
    return this.accepted
  }
  async accept(by: string): Promise<SharingAcceptance> {
    this.accepted ??= { by, at: new Date().toISOString() }
    return this.accepted
  }
}

export class InMemoryModulePrincipals implements ModulePrincipalStore {
  readonly hashes = new Map<string, string>()
  async setTokenHash(moduleId: string, tokenHash: string): Promise<void> {
    this.hashes.set(moduleId, tokenHash)
  }
  async tokenHash(moduleId: string): Promise<string | null> {
    return this.hashes.get(moduleId) ?? null
  }
}

export class InMemoryCursorStore implements EventCursorStore {
  readonly cursors = new Map<string, EventCursor>()
  async get(moduleId: string): Promise<EventCursor | null> {
    const c = this.cursors.get(moduleId)
    return c ? clone(c) : null
  }
  async put(cursor: EventCursor): Promise<void> {
    this.cursors.set(cursor.moduleId, clone(cursor))
  }
  async remove(moduleId: string): Promise<void> {
    this.cursors.delete(moduleId)
  }
}

/** Orders events like the kernel_events feed: by ts, then id. */
export function compareEvents(a: { ts: string; id: string }, b: { ts: string; id: string }): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** An EventFeed over an in-memory list (an InMemoryEventSink's `events`). */
export function inMemoryEventFeed(events: readonly KernelEvent[]): EventFeed {
  return {
    async after(position, types, limit) {
      const wanted = new Set(types)
      return [...events]
        .filter((e) => wanted.has(e.type) && e.ts >= position.startedAt)
        .filter(
          (e) =>
            position.lastTs === null ||
            compareEvents(e, { ts: position.lastTs, id: position.lastId ?? '' }) > 0,
        )
        .sort(compareEvents)
        .slice(0, limit)
    },
  }
}

/** A data repo in memory: what `data.*` wrote, and who. */
export class InMemoryDataRepo implements ModuleDataRepo {
  readonly files = new Map<string, Uint8Array>()
  readonly commits: { authorId: string; message: string; paths: string[] }[] = []

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null
  }
  async list(prefix: string): Promise<{ path: string; size: number }[]> {
    return [...this.files.entries()]
      .filter(([p]) => p.startsWith(prefix))
      .map(([path, bytes]) => ({ path, size: bytes.byteLength }))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
  }
  async write(
    changes: { path: string; bytes: Uint8Array | null }[],
    meta: { authorId: string; message: string },
  ): Promise<void> {
    for (const c of changes) {
      if (c.bytes === null) this.files.delete(c.path)
      else this.files.set(c.path, c.bytes)
    }
    this.commits.push({ ...meta, paths: changes.map((c) => c.path) })
  }
  snapshot(): DataFile[] {
    return [...this.files.entries()].map(([path, bytes]) => ({ path, bytes }))
  }
}
