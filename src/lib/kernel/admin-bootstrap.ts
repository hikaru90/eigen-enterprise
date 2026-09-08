import type { WiredKernel } from '../../../modules/index'
import type { AdminApprovalStore } from './admin-tools'
import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from './approvals'
import type { DbHandle } from './db-stores'
import type { ToolDescriptor } from './types'
import { asc, eq } from 'drizzle-orm'
import { kernelApprovals } from '$lib/server/db/kernel.schema'
import { registerModuleTools } from '../../../modules/index'
import {
  createAdminTools,
  kernelManifest,
  KERNEL_ADMIN_TOOL_NAMES,
  KERNEL_MODULE_ID,
} from './admin-tools'

/**
 * Boot composition for the kernel admin tools. Kept out of modules/index.ts
 * so the base kernel bootstrap stays free of admin wiring; consumers (the ee
 * CLI today, the web UI later) opt in by calling registerAdminTools(kernel).
 * Registration goes through the kernel's validated registerModuleTools path,
 * so the manifest ↔ tool contract holds here too.
 */

export type RegisterAdminToolsOptions = {
  /** Rich approval store to use instead of wrapping kernel.approvals (tests inject fakes). */
  approvals?: AdminApprovalStore
  /**
   * DB handle used to list approvals by status when kernel.approvals is a
   * plain ApprovalStore. Defaults to a pooled app handle (kernel tables carry
   * no RLS), matching the orchestrator's background path.
   */
  db?: DbHandle
}

/**
 * Register the kernel module manifest + admin tools into a wired kernel.
 * The kernel module is self-seeded active: the admin surface cannot be gated
 * on the very store it administers without a bootstrap deadlock (nothing
 * could ever activate the first module). Opaque errors from duplicate
 * registration propagate loudly.
 */
export async function registerAdminTools(
  kernel: WiredKernel,
  options: RegisterAdminToolsOptions = {},
): Promise<void> {
  await kernel.activations.set(KERNEL_MODULE_ID, true)

  // Idempotent convergence for in-process re-entry (CLI runCli may be called
  // more than once against the singleton kernel): already fully registered is
  // a no-op, partial registration stays loud.
  const alreadyRegistered =
    kernel.modules.get(KERNEL_MODULE_ID) !== undefined &&
    KERNEL_ADMIN_TOOL_NAMES.every((name) => kernel.registry.get(name) !== undefined)
  if (alreadyRegistered) return

  kernel.modules.register(kernelManifest)

  const approvals = options.approvals ?? listableApprovalStore(kernel.approvals, options.db)
  const tools: ToolDescriptor[] = createAdminTools({
    modules: kernel.modules,
    activations: kernel.activations,
    approvals,
  })
  registerModuleTools(kernel.registry, kernel.modules, tools)
}

/**
 * Adapt a plain ApprovalStore to the admin listing capability. Stores that
 * already implement list() pass through untouched. Otherwise pending listing
 * delegates to listPending(); any other status needs a DB handle and fails
 * loud without one — no silent empty results.
 */
export function listableApprovalStore(store: ApprovalStore, db?: DbHandle): AdminApprovalStore {
  if (typeof (store as AdminApprovalStore).list === 'function') {
    return store as AdminApprovalStore
  }

  const list = async (status?: ApprovalStatus): Promise<ApprovalRequest[]> => {
    if (status === 'pending') return store.listPending()
    if (!db) {
      if (status === undefined) {
        throw new Error(
          'cannot list approvals without a status filter: this store has no full listing and no DB handle was provided',
        )
      }
      throw new Error(
        `cannot list approvals with status "${status}": this store has no status listing and no DB handle was provided`,
      )
    }
    return listApprovalsFromDb(db, status)
  }

  return {
    create: (req) => store.create(req),
    decide: (id, status, decidedBy) => store.decide(id, status, decidedBy),
    listPending: () => store.listPending(),
    latestFor: (toolName, principalId) => store.latestFor(toolName, principalId),
    list,
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

async function listApprovalsFromDb(
  db: DbHandle,
  status?: ApprovalStatus,
): Promise<ApprovalRequest[]> {
  const handle = typeof db === 'function' ? await db() : db
  const rows = await handle
    .select(approvalColumns)
    .from(kernelApprovals)
    .where(status === undefined ? undefined : eq(kernelApprovals.status, status))
    .orderBy(asc(kernelApprovals.createdAt))
  return rows.map((row) => ({
    id: row.id,
    toolName: row.toolName,
    input: row.input,
    principalId: row.principalId,
    status: row.status,
    ...(row.decidedBy === null ? {} : { decidedBy: row.decidedBy }),
    ...(row.decidedAt === null ? {} : { decidedAt: row.decidedAt.toISOString() }),
  }))
}
