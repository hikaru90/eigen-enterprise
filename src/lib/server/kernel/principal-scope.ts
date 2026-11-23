import { actsAsMember } from '$lib/kernel/principals'
import type { PrincipalScope } from '$lib/kernel/registry'

/**
 * The kernel registry's row-level-security scope (KernelRegistry
 * `principalScope`, CB3): a tool call of a PERSON — their own, or the company
 * brain acting as them — or of an AI CO-WORKER (plan/phase-ai-coworkers.md §3)
 * runs inside that member's own RLS session, so Memory, Drive, calendar and the
 * rest see exactly what that member may see. A co-worker is scoped by its own
 * user id, like a new member: what is shared with the company or with it,
 * never anyone's private rows.
 *
 * - The surrounding async context already holds THIS member's session (a web
 *   request, the person's chat turn): the call runs in it, on the request's
 *   own connection.
 * - Anything else — no session at all (the Telegram poll, a background run,
 *   a co-worker's turn), or someone else's: the call opens the member's own
 *   session for its duration. A call never runs inside another member's session.
 * - Agents and services act at company level (kernel tables carry no RLS):
 *   their calls run as called.
 *
 * Lazy imports keep building the kernel free of any DB connection.
 */
export const livePrincipalScope: PrincipalScope = async (principal, run) => {
  if (!actsAsMember(principal)) return run()
  const { tenantUserAsyncLocal } = await import('$lib/server/db/tenant-context')
  const { appDbAsyncLocal, withDbUser } = await import('$lib/server/db')
  if (tenantUserAsyncLocal.getStore() === principal.id && appDbAsyncLocal.getStore()) return run()
  return withDbUser(principal.id, () => run())
}
