import type { ModuleManifestV1 } from '../../contracts/module-manifest'

/**
 * D13 (plan/phase-upgrades-u2.md §8): a first deploy, or one that widens what
 * a module may reach, needs an admin's own click. Structure only: each line
 * names one thing the new manifest grants that the deployed one did not.
 * Empty means the deploy follows the approval mode.
 */
export function wideningOf(before: ModuleManifestV1 | null, after: ModuleManifestV1): string[] {
  if (before === null) return ['a first deploy']
  const out: string[] = []
  const added = (was: readonly string[], now: readonly string[]) => now.filter((x) => !was.includes(x))
  for (const t of added(before.uses.tools, after.uses.tools)) out.push(`uses.tools: ${t}`)
  for (const e of added(before.uses.events, after.uses.events)) out.push(`uses.events: ${e}`)
  for (const s of added(before.uses.slots, after.uses.slots)) out.push(`uses.slots: ${s}`)
  if (!before.permissions.background && after.permissions.background) out.push('permissions.background')
  for (const s of added(before.permissions.secrets, after.permissions.secrets)) out.push(`permissions.secrets: ${s}`)
  for (const c of added(before.permissions.capabilities, after.permissions.capabilities)) {
    out.push(`permissions.capabilities: ${c}`)
  }
  for (const n of added(before.permissions.network, after.permissions.network)) out.push(`permissions.network: ${n}`)
  for (const tool of after.provides.tools) {
    const was = before.provides.tools.find((t) => t.name === tool.name)
    const roles = was ? added(was.roles, tool.roles) : tool.roles
    for (const r of roles) out.push(`provides.tools.${tool.name}.roles: ${r}`)
  }
  return out
}
