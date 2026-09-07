import type { ZodType } from 'zod'

export type ModuleManifest = {
  id: string
  name: string
  version: string
  description?: string
  /** Tool names owned by this module (namespaced "module.toolname"). */
  tools: string[]
  permissions: {
    roles: string[]
  }
  settingsSchema?: ZodType
}

export interface ActivationStore {
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

export class ModuleRegistry {
  private readonly manifests = new Map<string, ModuleManifest>()

  constructor(private readonly activations: ActivationStore) {}

  register(manifest: ModuleManifest): void {
    if (this.manifests.has(manifest.id)) {
      throw new Error(`module already registered: ${manifest.id}`)
    }
    this.manifests.set(manifest.id, manifest)
  }

  get(id: string): ModuleManifest | undefined {
    return this.manifests.get(id)
  }

  list(): ModuleManifest[] {
    return [...this.manifests.values()]
  }

  async activate(id: string): Promise<void> {
    this.requireManifest(id)
    await this.activations.set(id, true)
  }

  async deactivate(id: string): Promise<void> {
    this.requireManifest(id)
    await this.activations.set(id, false)
  }

  /**
   * Whether the module owning `toolName` is currently active.
   * Owning module id = toolName prefix before the first ".".
   * Unknown module (or unknown store state) => false, fail closed.
   */
  async isToolActive(toolName: string): Promise<boolean> {
    const dot = toolName.indexOf('.')
    if (dot <= 0) return false
    const moduleId = toolName.slice(0, dot)
    if (!this.manifests.has(moduleId)) return false
    return this.activations.get(moduleId)
  }

  private requireManifest(id: string): ModuleManifest {
    const manifest = this.manifests.get(id)
    if (!manifest) throw new Error(`unknown module: ${id}`)
    return manifest
  }
}
