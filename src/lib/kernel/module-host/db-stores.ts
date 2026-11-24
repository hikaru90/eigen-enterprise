import { and, asc, desc, eq, gt, gte, inArray, or, sql } from 'drizzle-orm'
import type { ModuleManifestV1 } from '../../../../contracts/module-manifest'
import type { ModuleReceiptV1 } from '../../../../contracts/module-receipt'
import type { AppDatabase } from '$lib/server/db/context'
import {
  kernelEvents,
  kernelModuleEventCursor,
  kernelModules,
  kernelModuleSharing,
  kernelModuleVersions,
  kernelPrincipals,
} from '$lib/server/db/kernel.schema'
import type { DbHandle } from '../db-stores'
import type { KernelEvent } from '../events'
import { modulePrincipalId } from './host'
import type {
  EventCursor,
  EventCursorStore,
  EventFeed,
  ModulePrincipalStore,
  ModuleRecord,
  ModuleStore,
  PublishedVersion,
  SharingAcceptance,
  SharingStore,
} from './types'

/**
 * The module host's stores over the kernel tables of migration 0179
 * (plan/phase-upgrades-u2.md §4.6): kernel_modules, kernel_module_versions,
 * kernel_module_event_cursor, kernel_module_sharing; the module principal
 * `module:<id>` in kernel_principals; the event feed over kernel_events.
 */

async function resolve(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

type ModuleRow = typeof kernelModules.$inferSelect

function toRecord(r: ModuleRow): ModuleRecord {
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    manifest: (r.manifest as ModuleManifestV1 | null) ?? null,
    receipt: (r.receipt as ModuleReceiptV1 | null) ?? null,
    commit: r.commit,
    bundleSha256: r.bundleSha256,
    state: r.state,
    reason: r.reason,
    stateSince: r.stateSince.toISOString(),
    firstDeployedAt: iso(r.firstDeployedAt),
    deployedFrom: r.deployedFrom,
    deployedBy: r.deployedBy,
    pendingDeploy: r.pendingDeploy ?? null,
  }
}

function toRow(r: ModuleRecord) {
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    manifest: r.manifest,
    receipt: r.receipt,
    commit: r.commit,
    bundleSha256: r.bundleSha256,
    state: r.state,
    reason: r.reason,
    stateSince: new Date(r.stateSince),
    firstDeployedAt: r.firstDeployedAt ? new Date(r.firstDeployedAt) : null,
    deployedFrom: r.deployedFrom,
    deployedBy: r.deployedBy,
    pendingDeploy: r.pendingDeploy,
  }
}

export class DbModuleStore implements ModuleStore {
  constructor(private readonly db: DbHandle) {}

  async get(id: string): Promise<ModuleRecord | null> {
    const [r] = await (await resolve(this.db)).select().from(kernelModules).where(eq(kernelModules.id, id)).limit(1)
    return r ? toRecord(r) : null
  }
  async list(): Promise<ModuleRecord[]> {
    return (await (await resolve(this.db)).select().from(kernelModules).orderBy(asc(kernelModules.id))).map(toRecord)
  }
  async create(record: ModuleRecord): Promise<void> {
    await (await resolve(this.db)).insert(kernelModules).values(toRow(record))
  }
  async put(record: ModuleRecord): Promise<void> {
    const { id, ...rest } = toRow(record)
    const updated = await (await resolve(this.db))
      .update(kernelModules)
      .set(rest)
      .where(eq(kernelModules.id, id))
      .returning({ id: kernelModules.id })
    if (updated.length !== 1) throw new Error(`company module ${id} does not exist`)
  }
  async remove(id: string): Promise<void> {
    await (await resolve(this.db)).delete(kernelModules).where(eq(kernelModules.id, id))
  }
  async versions(id: string): Promise<PublishedVersion[]> {
    const rows = await (await resolve(this.db))
      .select()
      .from(kernelModuleVersions)
      .where(eq(kernelModuleVersions.moduleId, id))
      .orderBy(desc(kernelModuleVersions.publishedAt))
    return rows.map(toVersion)
  }
  async version(id: string, commit: string): Promise<PublishedVersion | null> {
    const [r] = await (await resolve(this.db))
      .select()
      .from(kernelModuleVersions)
      .where(and(eq(kernelModuleVersions.moduleId, id), eq(kernelModuleVersions.commit, commit)))
      .limit(1)
    return r ? toVersion(r) : null
  }
  async addVersion(v: PublishedVersion): Promise<void> {
    await (await resolve(this.db)).insert(kernelModuleVersions).values({
      moduleId: v.moduleId,
      commit: v.commit,
      version: v.version,
      bundleSha256: v.bundleSha256,
      manifest: v.manifest,
      receipt: v.receipt,
      publishedAt: new Date(v.publishedAt),
    })
  }
}

function toVersion(r: typeof kernelModuleVersions.$inferSelect): PublishedVersion {
  return {
    moduleId: r.moduleId,
    commit: r.commit,
    version: r.version,
    bundleSha256: r.bundleSha256,
    manifest: r.manifest as ModuleManifestV1,
    receipt: r.receipt as ModuleReceiptV1,
    publishedAt: r.publishedAt.toISOString(),
  }
}

export class DbSharingStore implements SharingStore {
  constructor(private readonly db: DbHandle) {}
  async get(): Promise<SharingAcceptance | null> {
    const [r] = await (await resolve(this.db)).select().from(kernelModuleSharing).limit(1)
    return r ? { by: r.acceptedBy, at: r.acceptedAt.toISOString() } : null
  }
  async accept(by: string): Promise<SharingAcceptance> {
    // The first OK stands: a second one changes nothing.
    await (await resolve(this.db))
      .insert(kernelModuleSharing)
      .values({ id: 'company', acceptedBy: by })
      .onConflictDoNothing({ target: kernelModuleSharing.id })
    return (await this.get())!
  }
}

/** `module:<id>` in kernel_principals: kind service, no roles, the token's sha256 (§4.2). */
export class DbModulePrincipals implements ModulePrincipalStore {
  constructor(private readonly db: DbHandle) {}
  async setTokenHash(moduleId: string, tokenHash: string): Promise<void> {
    const id = modulePrincipalId(moduleId)
    await (await resolve(this.db))
      .insert(kernelPrincipals)
      .values({ id, kind: 'service', displayName: `Module ${moduleId}`, roles: [], apiKeyHash: tokenHash })
      .onConflictDoUpdate({ target: kernelPrincipals.id, set: { apiKeyHash: tokenHash, kind: 'service', roles: [] } })
  }
  async tokenHash(moduleId: string): Promise<string | null> {
    const [r] = await (await resolve(this.db))
      .select({ hash: kernelPrincipals.apiKeyHash, kind: kernelPrincipals.kind })
      .from(kernelPrincipals)
      .where(eq(kernelPrincipals.id, modulePrincipalId(moduleId)))
      .limit(1)
    return r && r.kind === 'service' ? (r.hash ?? null) : null
  }
}

export class DbCursorStore implements EventCursorStore {
  constructor(private readonly db: DbHandle) {}
  async get(moduleId: string): Promise<EventCursor | null> {
    const [r] = await (await resolve(this.db))
      .select()
      .from(kernelModuleEventCursor)
      .where(eq(kernelModuleEventCursor.moduleId, moduleId))
      .limit(1)
    if (!r) return null
    return {
      moduleId: r.moduleId,
      startedAt: r.startedAt.toISOString(),
      lastTs: iso(r.lastTs),
      lastId: r.lastId,
      attempts: r.attempts,
      failingSince: iso(r.failingSince),
      nextAttemptAt: iso(r.nextAttemptAt),
    }
  }
  async put(c: EventCursor): Promise<void> {
    const row = {
      startedAt: new Date(c.startedAt),
      lastTs: c.lastTs ? new Date(c.lastTs) : null,
      lastId: c.lastId,
      attempts: c.attempts,
      failingSince: c.failingSince ? new Date(c.failingSince) : null,
      nextAttemptAt: c.nextAttemptAt ? new Date(c.nextAttemptAt) : null,
    }
    await (await resolve(this.db))
      .insert(kernelModuleEventCursor)
      .values({ moduleId: c.moduleId, ...row })
      .onConflictDoUpdate({ target: kernelModuleEventCursor.moduleId, set: row })
  }
  async remove(moduleId: string): Promise<void> {
    await (await resolve(this.db)).delete(kernelModuleEventCursor).where(eq(kernelModuleEventCursor.moduleId, moduleId))
  }
}

/** kernel_events after a cursor: the given types, ts ≥ startedAt, (ts, id) after the last one, in order. */
export function dbEventFeed(db: DbHandle): EventFeed {
  return {
    async after(position, types, limit) {
      if (types.length === 0) return []
      const since = new Date(position.startedAt)
      const after =
        position.lastTs === null
          ? gte(kernelEvents.ts, since)
          : or(
              gt(kernelEvents.ts, new Date(position.lastTs)),
              and(eq(kernelEvents.ts, new Date(position.lastTs)), gt(kernelEvents.id, position.lastId ?? sql`'00000000-0000-0000-0000-000000000000'::uuid`)),
            )
      const rows = await (await resolve(db))
        .select()
        .from(kernelEvents)
        .where(and(inArray(kernelEvents.type, [...types]), gte(kernelEvents.ts, since), after))
        .orderBy(asc(kernelEvents.ts), asc(kernelEvents.id))
        .limit(limit)
      return rows.map(
        (r): KernelEvent => ({
          id: r.id,
          ts: r.ts.toISOString(),
          type: r.type,
          ...(r.principalId === null ? {} : { principalId: r.principalId }),
          ...(r.source === null ? {} : { source: r.source }),
          payload: r.payload,
        }),
      )
    },
  }
}
