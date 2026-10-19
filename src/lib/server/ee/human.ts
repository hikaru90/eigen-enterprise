import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'

/**
 * D11 (plan/phase-substrate.md): tools that change the server are human-only.
 * The agent reads text an attacker can influence, so it never changes the box
 * on the strength of it. Returns the commit author for ee.
 */
export function requireHuman(ctx: ToolContext, tool: string): string {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError(
      'permission_denied',
      `${tool} changes this server; only a human can do that (ask the owner to do it in Settings → Hosting)`,
    )
  }
  return `human:${ctx.principal.id}`
}
