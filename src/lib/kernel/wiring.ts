/**
 * Generic kernel wiring: the shape of a fully wired kernel and the validated
 * manifest ↔ tool registration path. Composition roots (modules/index, admin
 * bootstrap, later boot stages) import this from the kernel — the kernel
 * itself never imports module code.
 */

import type { ApprovalModeStore, ApprovalStore } from './approvals'
import type { EventSink } from './events'
import type { PrincipalStore } from './principals'
import type { KernelRegistry } from './registry'
import type { AgentSessionLog } from './session-log'
import type { ToolDescriptor } from './types'
import {
  manifestNamespaces,
  ModuleRegistry,
  toolNamespace,
  type ActivationStore,
} from './modules'

export type WiredKernel = {
  registry: KernelRegistry
  modules: ModuleRegistry
  activations: ActivationStore
  principals: PrincipalStore
  approvals: ApprovalStore
  /** Company-wide approval mode the owner picks (ask | reasonable | allow_all). */
  approvalMode: ApprovalModeStore
  eventSink: EventSink
  /** Durable agent conversation log (append-only) backing the loop engines. */
  sessionLog: AgentSessionLog
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
    if (!manifestNamespaces(manifest).includes(toolNamespace(tool.name))) {
      throw new Error(`tool ${tool.name} is not in a namespace of its module "${tool.module}"`)
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
