import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from './approvals'
import type { ActivationStore, ModuleManifest, ModuleRegistry } from './modules'
import type { ToolDescriptor } from './types'
import { z } from 'zod'
import { approvalActionLabel } from '$lib/chat/approval-copy'

/**
 * Kernel admin surface: module activation and approval decisions as regular
 * kernel tools. The CLI, the web UI, and future agents all share this one
 * permissioned, audited path — there is no out-of-band admin channel.
 */

export const KERNEL_MODULE_ID = 'kernel'

/** Tool names owned by the kernel module (single source of truth for the manifest). */
export const KERNEL_ADMIN_TOOL_NAMES = [
  'kernel.module_list',
  'kernel.module_activate',
  'kernel.module_deactivate',
  'kernel.approvals_list',
  'kernel.approvals_decide',
] as const

/**
 * Approval stores that can list requests by status. The base ApprovalStore
 * surface only exposes pending requests; admin listing needs the richer
 * capability. See admin-bootstrap.listableApprovalStore for the wiring.
 */
export type AdminApprovalStore = ApprovalStore & {
  list(status?: ApprovalStatus): Promise<ApprovalRequest[]>
}

/** The kernel module manifest (admin tools are gated like any other module). */
export const kernelManifest: ModuleManifest = {
  id: KERNEL_MODULE_ID,
  name: 'Kernel',
  // The kernel's own admin surface: never an owner-facing module card or page.
  internal: true,
  version: '0.1.0',
  description: 'Module activation and approval-decision administration for the kernel itself.',
  tools: [...KERNEL_ADMIN_TOOL_NAMES],
  permissions: { roles: ['admin'] },
}

export type AdminToolDeps = {
  modules: ModuleRegistry
  activations: ActivationStore
  approvals: AdminApprovalStore
}

const moduleListInput = z.object({})
const moduleIdInput = z.object({ module_id: z.string().min(1) })
const approvalsListInput = z.object({
  status: z.enum(['pending', 'approved', 'denied']).optional(),
})
const approvalsDecideInput = z.object({
  approval_id: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
})

/** Factory for the kernel admin ToolDescriptors — pure, deps injected, testable. */
export function createAdminTools(deps: AdminToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'kernel.module_list',
      module: KERNEL_MODULE_ID,
      summary: 'List all registered module manifests with their activation state.',
      auditClass: 'read',
      inputSchema: moduleListInput,
      permission: { roles: ['admin'] },
      handler: async () => {
        const manifests = deps.modules.list()
        const result = []
        for (const manifest of manifests) {
          const active = await deps.activations.get(manifest.id)
          result.push({
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            ...(manifest.description === undefined ? {} : { description: manifest.description }),
            // Internal = the agent's own machinery, not an owner-facing module card.
            ...(manifest.internal === true ? { internal: true } : {}),
            tools: manifest.tools,
            active,
          })
        }
        return result
      },
    },
    {
      name: 'kernel.module_activate',
      module: KERNEL_MODULE_ID,
      summary: 'Activate a registered module (its tools become executable).',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof moduleIdInput>) => `Switched on ${moduleName(deps.modules, input.module_id)}`,
      inputSchema: moduleIdInput,
      permission: { roles: ['admin'] },
      handler: async (_ctx, input) => {
        const parsed = moduleIdInput.parse(input)
        await requireModule(deps.modules, parsed.module_id).activate(parsed.module_id)
        return { module_id: parsed.module_id, active: true }
      },
    },
    {
      name: 'kernel.module_deactivate',
      module: KERNEL_MODULE_ID,
      summary: 'Deactivate a registered module (fail closed for its tools).',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof moduleIdInput>) => `Switched off ${moduleName(deps.modules, input.module_id)}`,
      approvalRisk: 'destructive',
      inputSchema: moduleIdInput,
      permission: { roles: ['admin'] },
      handler: async (_ctx, input) => {
        const parsed = moduleIdInput.parse(input)
        await requireModule(deps.modules, parsed.module_id).deactivate(parsed.module_id)
        return { module_id: parsed.module_id, active: false }
      },
    },
    {
      name: 'kernel.approvals_list',
      module: KERNEL_MODULE_ID,
      summary: 'List approval requests, optionally filtered by status.',
      auditClass: 'read',
      inputSchema: approvalsListInput,
      // The agent surfaces pending approvals in conversation (phase-3 one-agent:
      // governance lives in the transcript + audit trail, not the role table).
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async (_ctx, input) => {
        const parsed = approvalsListInput.parse(input)
        return deps.approvals.list(parsed.status)
      },
    },
    {
      name: 'kernel.approvals_decide',
      module: KERNEL_MODULE_ID,
      summary: 'Approve or deny a pending approval request.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof approvalsDecideInput>, output?: ApprovalRequest) => {
        const verb = input.decision === 'approved' ? 'Approved' : 'Turned down'
        return output ? `${verb}: ${approvalActionLabel(output.toolName)}` : `${verb} a request`
      },
      inputSchema: approvalsDecideInput,
      // Trust-the-transcript (plan/phase-3-one-agent.md, risks on record): the
      // agent executes the owner's conversational yes; decidedBy is audited.
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async (ctx, input) => {
        const parsed = approvalsDecideInput.parse(input)
        return deps.approvals.decide(parsed.approval_id, parsed.decision, ctx.principal.id)
      },
    },
  ]
}

/** A module by its manifest name ("the Email module"); an unknown id is quoted as given. */
function moduleName(modules: ModuleRegistry, id: string): string {
  const manifest = modules.get(id)
  return manifest ? `the ${manifest.name} module` : `the module “${id}”`
}

/** Loud validation: unknown module ids must fail, never no-op. */
function requireModule(modules: ModuleRegistry, id: string): ModuleRegistry {
  if (!modules.get(id)) throw new Error(`unknown module: ${id}`)
  return modules
}
