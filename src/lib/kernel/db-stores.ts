import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from './approvals'
import type { KernelEvent, EventSink } from './events'
import type { ActivationStore } from './modules'
import type { Principal, PrincipalStore } from './principals'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import {
  kernelApprovals,
  kernelEvents,
  kernelModuleActivations,
  kernelPrincipals,
} from '$lib/server/db/kernel.schema'

/**
 * DB handle for the kernel stores. Either an `AppDatabase` directly (tests
 * inject a fake) or a provider resolved per operation — a provider keeps
 * request-scoped handles (getDb()) fresh instead of binding one request's
 * connection into a long-lived store.
 */
export type DbHandle = AppDatabase | (() => AppDatabase | Promise<AppDatabase>)

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

/** EventSink persisting to the append-only kernel_events table. */
export class DbEventSink implements EventSink {
  constructor(private readonly db: DbHandle) {}

  async emit(event: KernelEvent): Promise<void> {
    await (await resolveDb(this.db)).insert(kernelEvents).values({
      id: event.id,
      ts: new Date(event.ts),
      type: event.type,
      ...(event.principalId === undefined ? {} : { principalId: event.principalId }),
      payload: event.payload,
    })
  }
}

/** ActivationStore persisting to kernel_module_activations (upsert on set). */
export class DbActivationStore implements ActivationStore {
  constructor(private readonly db: DbHandle) {}

  async set(id: string, active: boolean): Promise<void> {
    const now = new Date()
    await (
      await resolveDb(this.db)
    )
      .insert(kernelModuleActivations)
      .values({ moduleId: id, active, updatedAt: now })
      .onConflictDoUpdate({
        target: kernelModuleActivations.moduleId,
        set: { active, updatedAt: now },
      })
  }

  async get(id: string): Promise<boolean> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select({ active: kernelModuleActivations.active })
      .from(kernelModuleActivations)
      .where(eq(kernelModuleActivations.moduleId, id))
      .limit(1)
    return rows[0]?.active ?? false
  }

  async list(): Promise<Map<string, boolean>> {
    const rows = await (
      await resolveDb(this.db)
    ).select({ moduleId: kernelModuleActivations.moduleId, active: kernelModuleActivations.active }).from(kernelModuleActivations)
    return new Map(rows.map((row) => [row.moduleId, row.active]))
  }
}

function toPrincipal(row: {
  id: string
  kind: Principal['kind']
  displayName: string | null
  roles: string[]
  apiKeyHash: string | null
}): Principal {
  return {
    id: row.id,
    kind: row.kind,
    roles: row.roles,
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    apiKeyHash: row.apiKeyHash,
  }
}

const principalColumns = {
  id: kernelPrincipals.id,
  kind: kernelPrincipals.kind,
  displayName: kernelPrincipals.displayName,
  roles: kernelPrincipals.roles,
  apiKeyHash: kernelPrincipals.apiKeyHash,
}

/** PrincipalStore persisting to kernel_principals. */
export class DbPrincipalStore implements PrincipalStore {
  constructor(private readonly db: DbHandle) {}

  async getById(id: string): Promise<Principal | null> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select(principalColumns)
      .from(kernelPrincipals)
      .where(eq(kernelPrincipals.id, id))
      .limit(1)
    return rows[0] ? toPrincipal(rows[0]) : null
  }

  async getByApiKey(apiKeyHash: string): Promise<Principal | null> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select(principalColumns)
      .from(kernelPrincipals)
      .where(eq(kernelPrincipals.apiKeyHash, apiKeyHash))
      .limit(1)
    return rows[0] ? toPrincipal(rows[0]) : null
  }
}

type ApprovalRow = {
  id: string
  toolName: string
  input: unknown
  principalId: string
  status: ApprovalStatus
  decidedBy: string | null
  decidedAt: Date | null
}

function toApprovalRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    toolName: row.toolName,
    input: row.input,
    principalId: row.principalId,
    status: row.status,
    ...(row.decidedBy === null ? {} : { decidedBy: row.decidedBy }),
    ...(row.decidedAt === null ? {} : { decidedAt: row.decidedAt.toISOString() }),
  }
}

const approvalColumns = {
  id: kernelApprovals.id,
  toolName: kernelApprovals.toolName,
  input: kernelApprovals.input,
  principalId: kernelApprovals.principalId,
  status: kernelApprovals.status,
  decidedBy: kernelApprovals.decidedBy,
  decidedAt: kernelApprovals.decidedAt,
}

/** ApprovalStore persisting to kernel_approvals. */
export class DbApprovalStore implements ApprovalStore {
  constructor(private readonly db: DbHandle) {}

  async create(req: ApprovalRequest): Promise<ApprovalRequest> {
    const rows = await (
      await resolveDb(this.db)
    )
      .insert(kernelApprovals)
      .values({
        id: req.id,
        toolName: req.toolName,
        input: req.input,
        principalId: req.principalId,
        status: req.status,
        ...(req.decidedBy === undefined ? {} : { decidedBy: req.decidedBy }),
        ...(req.decidedAt === undefined ? {} : { decidedAt: new Date(req.decidedAt) }),
      })
      .returning(approvalColumns)
    if (!rows[0]) throw new Error('approval request insert returned no row')
    return toApprovalRequest(rows[0])
  }

  async decide(
    id: string,
    status: 'approved' | 'denied',
    decidedBy: string,
  ): Promise<ApprovalRequest> {
    const rows = await (
      await resolveDb(this.db)
    )
      .update(kernelApprovals)
      .set({ status, decidedBy, decidedAt: new Date() })
      .where(eq(kernelApprovals.id, id))
      .returning(approvalColumns)
    if (!rows[0]) throw new Error(`unknown approval request: ${id}`)
    return toApprovalRequest(rows[0])
  }

  async listPending(): Promise<ApprovalRequest[]> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select(approvalColumns)
      .from(kernelApprovals)
      .where(eq(kernelApprovals.status, 'pending'))
      .orderBy(asc(kernelApprovals.createdAt))
    return rows.map(toApprovalRequest)
  }

  async latestFor(toolName: string, principalId: string): Promise<ApprovalRequest | null> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select(approvalColumns)
      .from(kernelApprovals)
      .where(
        and(eq(kernelApprovals.toolName, toolName), eq(kernelApprovals.principalId, principalId)),
      )
      .orderBy(desc(kernelApprovals.createdAt))
      .limit(1)
    return rows[0] ? toApprovalRequest(rows[0]) : null
  }
}
