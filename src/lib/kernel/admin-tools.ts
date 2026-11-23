import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from './approvals'
import type { ToolDescriptor } from './types'
import { z } from 'zod'
import { approvalActionLabel } from '$lib/chat/approval-copy'
import { KernelError } from './errors'
import { moduleSwitchedOff, type ActivationStore, type ModuleManifest, type ModuleRegistry } from './modules'
import { KERNEL_NOTIFICATION_TOOL_NAMES } from './notification-tools'
import { isDirectHuman } from './principals'
import { KERNEL_DECISION_TOOL_NAMES } from './decision-tools'
import { KERNEL_EXPORT_TOOL_NAMES } from './export-tools'
import { KERNEL_OPERATIONS_TOOL_NAMES } from './operations-tools'
import { KERNEL_MEMBER_AI_CAP_TOOL_NAMES } from './member-ai-cap-tools'
import { KERNEL_SETTINGS_TOOL_NAMES } from './settings-tools'

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
  version: '0.2.0',
  description:
    'Module activation, approval decisions, who the agent runs as (whoami), the company settings (read; changes always wait for a person), the daily AI cap per member and a person’s own AI usage today, a person’s own notification devices and settings, the company logo, a backup now and installing a release (each waits for the owner), the company export (owner only), and the decision plane: decision kinds with their agreement, the decision log, and a person’s open decision questions and answers.',
  // `settings`: the company settings tools (settings-tools.ts) belong to the kernel core;
  // `notifications`: a person's own notification devices (notification-tools.ts).
  // `decisions`: the decision plane's kinds, log and Needs you questions (decision-tools.ts, CB2).
  toolNamespaces: [KERNEL_MODULE_ID, 'settings', 'notifications', 'decisions'],
  tools: [
    ...KERNEL_ADMIN_TOOL_NAMES,
    ...KERNEL_SETTINGS_TOOL_NAMES,
    ...KERNEL_NOTIFICATION_TOOL_NAMES,
    ...KERNEL_OPERATIONS_TOOL_NAMES,
    ...KERNEL_MEMBER_AI_CAP_TOOL_NAMES,
    ...KERNEL_EXPORT_TOOL_NAMES,
    ...KERNEL_DECISION_TOOL_NAMES,
  ],
  permissions: { roles: ['admin'] },
}

export type AdminToolDeps = {
  modules: ModuleRegistry
  activations: ActivationStore
  approvals: AdminApprovalStore
  /**
   * The registered descriptor of a tool name (the registry's get). Decides
   * whether a request belongs to an always-ask tool (approvalAlways), which
   * only a human principal may decide.
   */
  tool: (name: string) => ToolDescriptor | undefined
}

/**
 * The core is what has no sidebar entry: the kernel and every `internal`
 * module (owner, 2026-11-12: everything with a sidebar entry is a plugin and
 * can be switched off; the core cannot).
 */
export function isCoreModule(manifest: ModuleManifest): boolean {
  return manifest.id === KERNEL_MODULE_ID || manifest.internal === true
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
  const name = (id: string) => deps.modules.get(id)?.name ?? id
  const names = (ids: string[]) => ids.map(name).join(', ')
  return [
    {
      name: 'kernel.module_list',
      module: KERNEL_MODULE_ID,
      summary:
        'List all registered module manifests with their activation state, whether each is core (cannot be switched off), the modules it requires and the modules that require it.',
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
            core: isCoreModule(manifest),
            requires: manifest.requires ?? [],
            requiredBy: manifests.filter((m) => m.requires?.includes(manifest.id)).map((m) => m.id),
          })
        }
        return result
      },
    },
    {
      name: 'kernel.module_activate',
      module: KERNEL_MODULE_ID,
      summary:
        'Activate a registered module (its tools become executable). Refused while a module it requires is switched off, and for an agent when a person switched this module off (only a person switches it back on).',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof moduleIdInput>) => `Switched on ${moduleName(deps.modules, input.module_id)}`,
      inputSchema: moduleIdInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const parsed = moduleIdInput.parse(input)
        const manifest = requireManifest(deps.modules, parsed.module_id)
        // Owner, 2026-11-12: a plugin a person switched off is switched back on
        // by a person only — an agent (or service) may switch on what was never
        // switched on, so there is no approval-free way around the switch.
        // A person's own click — the brain acting for them (CB3) is not one.
        if (!isDirectHuman(ctx.principal) && (await moduleSwitchedOff(deps.activations, manifest.id))) {
          throw new KernelError(
            'module_switched_off',
            `${manifest.name} was switched off by a person. Only the owner or an admin can switch it back on, in Settings → Plugins.`,
            { module: manifest.id },
          )
        }
        const missing: string[] = []
        for (const id of manifest.requires ?? []) if (!(await deps.activations.get(id))) missing.push(id)
        if (missing.length > 0) {
          throw new KernelError(
            'module_required',
            `${manifest.name} needs ${names(missing)}: switch on ${names(missing)} first.`,
            { module: manifest.id, missing },
          )
        }
        await deps.modules.activate(manifest.id)
        return { module_id: manifest.id, active: true }
      },
    },
    {
      name: 'kernel.module_deactivate',
      module: KERNEL_MODULE_ID,
      summary:
        'Deactivate a registered module (fail closed for its tools; its data is kept). Refused for core modules and while an active module requires it.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof moduleIdInput>) => `Switched off ${moduleName(deps.modules, input.module_id)}`,
      approvalRisk: 'destructive',
      inputSchema: moduleIdInput,
      permission: { roles: ['admin'] },
      handler: async (_ctx, input) => {
        const parsed = moduleIdInput.parse(input)
        const manifest = requireManifest(deps.modules, parsed.module_id)
        if (isCoreModule(manifest)) {
          throw new KernelError(
            'core_module',
            `${manifest.name} is part of the eigenEnterprise core and cannot be switched off.`,
            { module: manifest.id },
          )
        }
        const dependents: string[] = []
        for (const m of deps.modules.list()) {
          if (m.requires?.includes(manifest.id) && (await deps.activations.get(m.id))) dependents.push(m.id)
        }
        if (dependents.length > 0) {
          throw new KernelError(
            'module_required',
            `${names(dependents)} ${dependents.length === 1 ? 'needs' : 'need'} ${manifest.name}: switch off ${names(dependents)} first.`,
            { module: manifest.id, requiredBy: dependents },
          )
        }
        await deps.modules.deactivate(manifest.id)
        return { module_id: manifest.id, active: false }
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
        if (!isDirectHuman(ctx.principal)) {
          // The always-on approval wall: an agent — or the brain acting for a
          // person (CB3) — never decides its own way past it.
          const request = (await deps.approvals.list()).find((r) => r.id === parsed.approval_id)
          if (request && deps.tool(request.toolName)?.approvalAlways === true) {
            throw new KernelError(
              'human_decision_required',
              `${approvalActionLabel(request.toolName)} always waits for a person: the owner or an admin approves or denies it on the approval card.`,
              { approvalId: request.id, tool: request.toolName },
            )
          }
        }
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
function requireManifest(modules: ModuleRegistry, id: string): ModuleManifest {
  const manifest = modules.get(id)
  if (!manifest) throw new KernelError('unknown_module', `unknown module: ${id}`, { module: id })
  return manifest
}
