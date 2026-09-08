import type { AgentConfig } from './agent'
import type { ToolDescriptor } from './types'

/**
 * THE shared tool-surface filter (plan/phase-1b-harness.md: never duplicated
 * per consumer). One pure pass over registry tools:
 *
 *   activation ∩ principal-role intersection ∩ agent module scope — fail closed.
 *
 * The orchestrator brain (now a harness config) and the AgentRuntime's
 * EngineContext.listTools both resolve the offered surface through this
 * function; the MCP listing applies the same activation gate at its layer.
 */
export type ToolSurfaceFilter = {
  /** Module activation predicate (ModuleRegistry.isToolActive); unknown ⇒ false. */
  isToolActive: (toolName: string) => Promise<boolean>
  /** Principal roles; a tool is offered only when its required roles intersect. */
  roles: string[]
  /** Agent tool scope: 'all' modules, or a module-id allowlist. */
  toolScope?: AgentConfig['toolScope']
}

export async function selectToolSurface(
  tools: readonly ToolDescriptor[],
  filter: ToolSurfaceFilter,
): Promise<ToolDescriptor[]> {
  const offered: ToolDescriptor[] = []
  for (const tool of tools) {
    if (!(await filter.isToolActive(tool.name))) continue
    if (!tool.permission.roles.some((role) => filter.roles.includes(role))) continue
    if (filter.toolScope !== undefined && filter.toolScope !== 'all') {
      if (!filter.toolScope.modules.includes(tool.module)) continue
    }
    offered.push(tool)
  }
  return offered
}
