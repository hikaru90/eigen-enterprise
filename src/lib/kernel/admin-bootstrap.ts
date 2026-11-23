import type { WiredKernel } from '../../../modules/index'
import type { AdminApprovalStore } from './admin-tools'
import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from './approvals'
import type { DbHandle } from './db-stores'
import type { ToolDescriptor } from './types'
import { asc, eq } from 'drizzle-orm'
import { kernelApprovals } from '$lib/server/db/kernel.schema'
import {
  createAdminTools,
  kernelManifest,
  KERNEL_ADMIN_TOOL_NAMES,
  KERNEL_MODULE_ID,
} from './admin-tools'
import {
  createMemberAiCapTools,
  KERNEL_MEMBER_AI_CAP_TOOL_NAMES,
  type MemberAiCapPort,
} from './member-ai-cap-tools'
import { createNotificationTools, KERNEL_NOTIFICATION_TOOL_NAMES, type NotificationsPort } from './notification-tools'
import { createExportTools, KERNEL_EXPORT_TOOL_NAMES, type ExportPort } from './export-tools'
import { createOperationsTools, KERNEL_OPERATIONS_TOOL_NAMES, type OperationsPort } from './operations-tools'
import { createSettingsTools, KERNEL_SETTINGS_TOOL_NAMES, type SettingsPort } from './settings-tools'
import { registerModuleTools } from './wiring'

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
  /** Overrides the live company-settings port (tests inject fakes; the live one imports the server lazily). */
  settings?: SettingsPort
  /** Overrides the live notification-devices port (tests inject fakes). */
  notifications?: NotificationsPort
  /** Overrides the live company-operations port (tests inject fakes). */
  operations?: OperationsPort
  /** Overrides the live daily-AI-cap-per-member port (tests inject fakes). */
  memberAiCap?: MemberAiCapPort
  /** Overrides the live company-export port (tests inject fakes). */
  exports?: ExportPort
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
    [
      ...KERNEL_ADMIN_TOOL_NAMES,
      ...KERNEL_SETTINGS_TOOL_NAMES,
      ...KERNEL_NOTIFICATION_TOOL_NAMES,
      ...KERNEL_OPERATIONS_TOOL_NAMES,
      ...KERNEL_MEMBER_AI_CAP_TOOL_NAMES,
      ...KERNEL_EXPORT_TOOL_NAMES,
    ].every(
      (name) => kernel.registry.get(name) !== undefined,
    )
  if (alreadyRegistered) return

  kernel.modules.register(kernelManifest)

  const approvals = options.approvals ?? listableApprovalStore(kernel.approvals, options.db)
  const tools: ToolDescriptor[] = createAdminTools({
    modules: kernel.modules,
    activations: kernel.activations,
    approvals,
    tool: (name) => kernel.registry.get(name),
  })
  tools.push(
    ...createSettingsTools({
      port: options.settings ?? liveSettingsPort(),
      approvalMode: kernel.approvalMode,
    }),
    ...createNotificationTools({ port: options.notifications ?? liveNotificationsPort() }),
    ...createOperationsTools({ port: options.operations ?? liveOperationsPort() }),
    ...createMemberAiCapTools({ port: options.memberAiCap ?? liveMemberAiCapPort() }),
    ...createExportTools({ port: options.exports ?? liveExportPort() }),
  )
  registerModuleTools(kernel.registry, kernel.modules, tools)
}

/** The live settings port, loaded on first use so registering the tools touches no server module. */
function liveSettingsPort(): SettingsPort {
  const live = async () => (await import('$lib/server/settings/agent-settings')).agentSettingsPort
  return {
    modelFor: async (identity) => (await live()).modelFor(identity),
    person: async (id) => (await live()).person(id),
    read: async () => (await live()).read(),
    apply: async (change, actor) => (await live()).apply(change, actor),
  }
}

/** The live notification-devices port, loaded on first use (like the settings port). */
function liveNotificationsPort(): NotificationsPort {
  const live = async () => (await import('$lib/server/push/test-notification')).liveNotificationsPort
  return {
    devices: async (userId) => (await live()).devices(userId),
    sendTest: async (userId, deviceId) => (await live()).sendTest(userId, deviceId),
    loadSettings: async (userId) => (await live()).loadSettings(userId),
    saveSettings: async (userId, input) => (await live()).saveSettings(userId, input),
  }
}

/** The live daily-AI-cap-per-member port (DC3), loaded on first use (like the settings port). */
function liveMemberAiCapPort(): MemberAiCapPort {
  const cap = async () => await import('$lib/server/llm/member-daily-cap')
  const store = async () => (await import('$lib/server/llm/member-daily-cap-store')).memberDailyCapStore
  return {
    readCapUsd: async () => (await store()).readCapUsd(),
    setCapUsd: async (value, actor) => (await store()).setCapUsd(value, actor),
    usageToday: async (userId) => (await cap()).memberAiUsageToday(userId),
  }
}

/** The live company-operations port (logo, backup now, release install), loaded on first use. */
function liveOperationsPort(): OperationsPort {
  const live = async () => (await import('$lib/server/settings/operations')).liveOperationsPort
  return {
    can: async (userId, capability) => (await live()).can(userId, capability),
    setLogo: async (userId, input) => (await live()).setLogo(userId, input),
    recropLogo: async (userId, crop) => (await live()).recropLogo(userId, crop),
    removeLogo: async (userId) => (await live()).removeLogo(userId),
    runBackup: async (author) => (await live()).runBackup(author),
    installRelease: async (release, author) => (await live()).installRelease(release, author),
  }
}

/** The live company-export port, loaded on first use (registering the tools touches no server module). */
function liveExportPort(): ExportPort {
  const live = async () => (await import('$lib/server/export/company/live')).liveExportPort
  return {
    isOwner: async (userId) => (await live()).isOwner(userId),
    start: async (userId) => (await live()).start(userId),
    get: async (id) => (await live()).get(id),
    list: async () => (await live()).list(),
    remove: async (id) => (await live()).remove(id),
  }
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
    consume: (id) => store.consume(id),
    openFor: (toolName, principalId) => store.openFor(toolName, principalId),
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
  consumedAt: kernelApprovals.consumedAt,
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
    ...(row.consumedAt ? { consumedAt: row.consumedAt.toISOString() } : {}),
  }))
}
