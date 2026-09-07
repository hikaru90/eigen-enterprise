import { StaticApprovalPolicy, type ApprovalStore } from '$lib/kernel/approvals'
import {
  DbActivationStore,
  DbApprovalStore,
  DbEventSink,
  DbPrincipalStore,
  type DbHandle,
} from '$lib/kernel/db-stores'
import type { EventSink } from '$lib/kernel/events'
import { ModuleRegistry, type ActivationStore } from '$lib/kernel/modules'
import type { PrincipalStore } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolDescriptor } from '$lib/kernel/types'
import { GitCommitter, type VcsCommitter } from '$lib/kernel/vcs'
import { emailManifest } from './email/manifest'
import { createEmailTools } from './email/tools'
import { memoryManifest } from './memory/manifest'
import { createMemoryTools } from './memory/tools'

/** The static module surface of this eigenEnterprise instance. */
export const moduleManifests = [memoryManifest, emailManifest] as const

/** Tools that always require an approval decision before first execution. */
export const APPROVAL_REQUIRED_TOOLS: ReadonlySet<string> = new Set(['email.send_mail'])

export type WiredKernel = {
  registry: KernelRegistry
  modules: ModuleRegistry
  activations: ActivationStore
  principals: PrincipalStore
  approvals: ApprovalStore
  eventSink: EventSink
}

export type BootstrapKernelOptions = {
  /** Overrides the lazy per-request `getDb()` handle (tests inject fakes). */
  db?: DbHandle
  activations?: ActivationStore
  eventSink?: EventSink
  approvalStore?: ApprovalStore
  principals?: PrincipalStore
  /** Defaults to a real GitCommitter; pass null to disable autocommit. */
  vcsCommitter?: VcsCommitter | null
}

/**
 * Registers every manifest and validates the tool ↔ manifest contract:
 * descriptor module must own the namespaced name, every descriptor must be
 * listed in its manifest, and every manifest tool must have a descriptor.
 */
function registerModuleTools(
  registry: KernelRegistry,
  modules: ModuleRegistry,
  tools: ToolDescriptor[],
): void {
  for (const tool of tools) {
    const manifest = modules.get(tool.module)
    if (!manifest) {
      throw new Error(`tool ${tool.name} has no registered module manifest for "${tool.module}"`)
    }
    if (!tool.name.startsWith(`${tool.module}.`)) {
      throw new Error(`tool ${tool.name} is not namespaced by its module "${tool.module}"`)
    }
    if (!manifest.tools.includes(tool.name)) {
      throw new Error(`tool ${tool.name} is missing from manifest "${tool.module}".tools`)
    }
    registry.register(tool)
  }

  for (const manifest of modules.list()) {
    for (const name of manifest.tools) {
      if (!registry.get(name)) {
        throw new Error(`manifest "${manifest.id}" lists unregistered tool ${name}`)
      }
    }
  }
}

/**
 * Build a fully wired kernel. Defaults are DB-backed (kernel_* tables) with a
 * lazy db provider so nothing connects until an operation actually runs;
 * inject fakes for in-memory use.
 */
export function buildKernel(options: BootstrapKernelOptions = {}): WiredKernel {
  const db: DbHandle =
    options.db ??
    (async () => {
      const { getDb } = await import('$lib/server/db')
      return getDb()
    })

  const activations = options.activations ?? new DbActivationStore(db)
  const eventSink = options.eventSink ?? new DbEventSink(db)
  const approvalStore = options.approvalStore ?? new DbApprovalStore(db)
  const principals = options.principals ?? new DbPrincipalStore(db)
  const vcsCommitter = options.vcsCommitter === undefined ? new GitCommitter() : options.vcsCommitter

  const modules = new ModuleRegistry(activations)
  for (const manifest of moduleManifests) modules.register(manifest)

  const registry = new KernelRegistry({
    eventSink,
    activationStore: activations,
    approvalPolicy: new StaticApprovalPolicy(APPROVAL_REQUIRED_TOOLS),
    approvalStore,
    vcsCommitter,
  })

  registerModuleTools(registry, modules, [...createMemoryTools(), ...createEmailTools()])

  return { registry, modules, activations, principals, approvals: approvalStore, eventSink }
}

let singleton: WiredKernel | null = null

/** Process-wide kernel (first call wins; later options are ignored). */
export function bootstrapKernel(options: BootstrapKernelOptions = {}): WiredKernel {
  if (!singleton) singleton = buildKernel(options)
  return singleton
}
