import type { AgentTypeSpec, VerificationPolicySpec } from './agent'
import type { ZodType } from 'zod'
import { KernelError } from './errors'
import { isCompanyModuleName, manifestSchema } from './manifest-schema'

export type ModuleManifest = {
  id: string
  name: string
  version: string
  description?: string
  /**
   * Tool-name prefixes this module owns (the part before the first ".").
   * Omitted = exactly [id]. A merged module (plan/phase-platform.md step 1)
   * lists its own id plus the namespaces it absorbed, so existing tool names
   * keep working unchanged. Every namespace has exactly one owner (fail loud).
   */
  toolNamespaces?: string[]
  /**
   * true = part of the agent's machinery, not an owner-facing module (no
   * module card, no /m/<id> page). Its tools stay available to the agent.
   */
  internal?: boolean
  /**
   * Module ids this module needs switched on to work (Calls needs Messages
   * for DM and channel calls). Declarative: the kernel reports it (who needs
   * whom, kernel.module_list) and does not enforce it. Omitted = none.
   */
  requires?: string[]
  /** Tool names owned by this module (namespaced "<namespace>.toolname"). */
  tools: string[]
  permissions: {
    roles: string[]
  }
  settingsSchema?: ZodType
  /**
   * Declarative agent types this module contributes (additive, optional).
   * v0: documentation only — nothing registers or enforces these yet;
   * hosting an agent stays an explicit AgentRuntime.registerAgent step.
   */
  agents?: AgentTypeSpec[]
  /**
   * Declarative verification policies (additive, optional).
   * v0: documentation only — no runtime enforces them yet.
   */
  verification?: VerificationPolicySpec[]
}

export type ActivationStore = {
  set(id: string, active: boolean): Promise<void>
  /** Whether the module is active. Unknown ids must resolve to false (fail closed). */
  get(id: string): Promise<boolean>
  list(): Promise<Map<string, boolean>>
}

export class InMemoryActivationStore implements ActivationStore {
  private readonly state = new Map<string, boolean>()

  async set(id: string, active: boolean): Promise<void> {
    this.state.set(id, active)
  }

  async get(id: string): Promise<boolean> {
    return this.state.get(id) ?? false
  }

  async list(): Promise<Map<string, boolean>> {
    return new Map(this.state)
  }
}

/**
 * What a company module's switch does beyond its activation record
 * (plan/phase-upgrades-u2.md §4.6): the module host starts it on (or retries
 * a failed one) and stops it off, through ee. Called by `activate` before the
 * record turns true (a start that fails leaves it as it was) and by
 * `deactivate` after it turned false (its tools are gated at once).
 */
export type CompanyModuleSwitch = {
  switchedOn(kernelModuleId: string): Promise<void>
  switchedOff(kernelModuleId: string): Promise<void>
}

export class ModuleRegistry {
  private readonly manifests = new Map<string, ModuleManifest>()
  /** Tool namespace → owning module id. */
  private readonly namespaces = new Map<string, string>()
  /** Kernel ids (`x-<id>`) of the company modules registered through registerCompanyModule. */
  private readonly companyModules = new Set<string>()
  private companySwitch: CompanyModuleSwitch | null = null

  constructor(private readonly activations: ActivationStore) {}

  /**
   * A core (compiled-in) manifest. Refuses any id or namespace in the
   * company-module space (`x-…`/`x_…`, D3): module tools can never shadow core
   * tools, and the core never owns a module's names.
   */
  register(manifest: ModuleManifest): void {
    for (const name of [manifest.id, ...manifestNamespaces(manifest)]) {
      if (isCompanyModuleName(name)) {
        throw new Error(
          `module ${manifest.id}: "${name}" is in the company-module space (x-/x_); only a company module (registerCompanyModule) may own it`,
        )
      }
    }
    this.registerChecked(manifest)
  }

  /**
   * A company module's manifest (the module host, §4.5): its id is exactly
   * `x-<id>` and it owns exactly the namespaces `x-<id>` and `x_<id_>`.
   */
  registerCompanyModule(manifest: ModuleManifest, localId: string): void {
    const id = `x-${localId}`
    const namespace = `x_${localId.replaceAll('-', '_')}`
    const owned = manifestNamespaces(manifest)
    if (
      manifest.id !== id ||
      owned.length !== 2 ||
      !owned.includes(id) ||
      !owned.includes(namespace)
    ) {
      throw new Error(
        `company module ${localId} must be registered as ${id} owning exactly the namespaces ${id} and ${namespace}`,
      )
    }
    this.registerChecked(manifest)
    this.companyModules.add(id)
  }

  /** Removes a company module's manifest (a redeploy that changed what it provides, or a removal). */
  unregisterCompanyModule(kernelModuleId: string): void {
    if (!this.companyModules.has(kernelModuleId)) {
      throw new Error(`${kernelModuleId} is not a registered company module`)
    }
    const manifest = this.requireManifest(kernelModuleId)
    for (const namespace of manifestNamespaces(manifest)) this.namespaces.delete(namespace)
    this.manifests.delete(kernelModuleId)
    this.companyModules.delete(kernelModuleId)
  }

  isCompanyModule(id: string): boolean {
    return this.companyModules.has(id)
  }

  /** Wires the module host's switch (once; a second host fails loud). */
  setCompanyModuleSwitch(companySwitch: CompanyModuleSwitch): void {
    if (this.companySwitch) throw new Error('the company module switch is already wired')
    this.companySwitch = companySwitch
  }

  private registerChecked(manifest: ModuleManifest): void {
    const parsed = manifestSchema.safeParse(manifest)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(
        `invalid module manifest ${manifest.id}: ${issue.path.join('.')}: ${issue.message}`,
      )
    }
    if (manifest.requires?.includes(manifest.id)) {
      throw new Error(`module ${manifest.id} cannot require itself`)
    }
    if (this.manifests.has(manifest.id)) {
      throw new Error(`module already registered: ${manifest.id}`)
    }
    const owned = manifestNamespaces(manifest)
    if (!owned.includes(manifest.id)) {
      throw new Error(`toolNamespaces of module ${manifest.id} must include its own id`)
    }
    for (const namespace of owned) {
      const owner = this.namespaces.get(namespace)
      if (owner !== undefined) {
        throw new Error(`namespace "${namespace}" is already owned by module ${owner}`)
      }
    }
    for (const name of manifest.tools) {
      if (!owned.includes(toolNamespace(name))) {
        throw new Error(`tool ${name} is outside the namespaces of module ${manifest.id}`)
      }
    }
    for (const namespace of owned) this.namespaces.set(namespace, manifest.id)
    this.manifests.set(manifest.id, manifest)
  }

  /** The module that owns a tool namespace (prefix before the first "."), if any. */
  ownerOfNamespace(namespace: string): ModuleManifest | undefined {
    const id = this.namespaces.get(namespace)
    return id === undefined ? undefined : this.manifests.get(id)
  }

  get(id: string): ModuleManifest | undefined {
    return this.manifests.get(id)
  }

  list(): ModuleManifest[] {
    return [...this.manifests.values()]
  }

  async activate(id: string): Promise<void> {
    this.requireManifest(id)
    if (this.companyModules.has(id)) await this.requireSwitch(id).switchedOn(id)
    await this.activations.set(id, true)
  }

  async deactivate(id: string): Promise<void> {
    this.requireManifest(id)
    await this.activations.set(id, false)
    if (this.companyModules.has(id)) await this.requireSwitch(id).switchedOff(id)
  }

  private requireSwitch(id: string): CompanyModuleSwitch {
    if (!this.companySwitch) {
      throw new Error(`company module ${id} cannot be switched: no module host is wired`)
    }
    return this.companySwitch
  }

  /**
   * Whether the module owning `toolName` is currently active.
   * Owning module = the module whose toolNamespaces contain the toolName
   * prefix before the first ".".
   * Unknown module (or unknown store state) => false, fail closed.
   */
  async isToolActive(toolName: string): Promise<boolean> {
    const dot = toolName.indexOf('.')
    if (dot <= 0) return false
    const owner = this.ownerOfNamespace(toolName.slice(0, dot))
    if (!owner) return false
    return this.activations.get(owner.id)
  }

  private requireManifest(id: string): ModuleManifest {
    const manifest = this.manifests.get(id)
    if (!manifest) throw new Error(`unknown module: ${id}`)
    return manifest
  }
}

/**
 * Whether a person switched the module off on purpose: its activation record
 * says false. No record = never switched on (a fresh box, a plugin never set
 * up) — the agent may switch that one on; a switched-off one only a person
 * (owner, 2026-11-12).
 */
export async function moduleSwitchedOff(store: ActivationStore, id: string): Promise<boolean> {
  return (await store.list()).get(id) === false
}

/**
 * The `module_inactive` error for a tool of an inactive module, carrying
 * `switchedOff` as structured detail (what the agent may do about it is
 * decided from that, never from the message).
 */
export async function moduleInactiveError(store: ActivationStore, moduleId: string, tool: string): Promise<KernelError> {
  const switchedOff = await moduleSwitchedOff(store, moduleId)
  const message = switchedOff
    ? `module ${moduleId} is switched off; cannot execute ${tool}. Only the owner or an admin can switch it back on, in Settings → Plugins.`
    : `module ${moduleId} is not active; cannot execute ${tool}`
  return new KernelError('module_inactive', message, { module: moduleId, tool, switchedOff })
}

/** The namespaces a manifest owns: its declared toolNamespaces, or exactly [id]. */
export function manifestNamespaces(manifest: ModuleManifest): string[] {
  return manifest.toolNamespaces ?? [manifest.id]
}

/** A tool name's namespace: the prefix before the first ".". */
export function toolNamespace(toolName: string): string {
  const dot = toolName.indexOf('.')
  if (dot <= 0) throw new Error(`tool name ${toolName} has no namespace`)
  return toolName.slice(0, dot)
}
