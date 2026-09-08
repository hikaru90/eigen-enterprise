/**
 * Generic kernel wiring: the shape of a fully wired kernel and the validated
 * manifest ↔ tool registration path. Composition roots (modules/index, admin
 * bootstrap, later boot stages) import this from the kernel — the kernel
 * itself never imports module code.
 */

import type { ApprovalStore } from './approvals'
import type { EventSink } from './events'
import type { PrincipalStore } from './principals'
import type { KernelRegistry } from './registry'
import type { ToolDescriptor } from './types'
import { ModuleRegistry, type ActivationStore } from './modules'

export type WiredKernel = {
  registry: KernelRegistry
  modules: ModuleRegistry
  activations: ActivationStore
  principals: PrincipalStore
  approvals: ApprovalStore
  eventSink: EventSink
}

/**
 * Registers every manifest and validates the tool ↔ manifest contract:
 * descriptor module must own the namespaced name, every descriptor must be
 * listed in its manifest, and every manifest tool must have a descriptor.
 * Exported so later boot stages (e.g. registering the chat-gateway surface)
 * go through the identical validated path.
 */
export function registerModuleTools(
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
