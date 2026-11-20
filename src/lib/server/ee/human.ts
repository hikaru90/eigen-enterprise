import { KernelError } from '$lib/kernel/errors'
import { isDirectHuman } from '$lib/kernel/principals'
import type { ToolContext } from '$lib/kernel/types'

/**
 * D11 (plan/phase-substrate.md): tools that change the server are human-only.
 * The agent reads text an attacker can influence, so it never changes the box
 * on the strength of it. Returns the commit author for ee. `where` names the
 * page a person does it from (default Settings → Hosting).
 */
export function requireHuman(ctx: ToolContext, tool: string, where = 'Settings → Hosting'): string {
  // The person at their own keyboard — never the brain acting for them (CB3).
  if (!isDirectHuman(ctx.principal)) {
    throw new KernelError(
      'permission_denied',
      `${tool} changes this server; only a human can do that (ask the owner to do it in ${where})`,
    )
  }
  return `human:${ctx.principal.id}`
}
