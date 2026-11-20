import type { PrincipalScope } from '$lib/kernel/registry'

/**
 * The kernel registry's row-level-security scope (KernelRegistry
 * `principalScope`, CB3): a tool call of a PERSON — their own, or the company
 * brain acting as them — runs inside that person's RLS session, so Memory,
 * Drive, calendar and the rest see exactly what the person may see.
 *
 * - The surrounding async context already holds THIS person's session (a web
 *   request, the person's chat turn): the call runs in it, on the request's
 *   own connection.
 * - Anything else — no session at all (the Telegram poll, a background run),
 *   or someone else's: the call opens the person's own session for its
 *   duration. A call never runs inside another person's session.
 * - Agents and services act at company level (kernel tables carry no RLS):
 *   their calls run as called.
 *
 * Lazy imports keep building the kernel free of any DB connection.
 */
export const livePrincipalScope: PrincipalScope = async (principal, run) => {
  if (principal.kind !== 'human') return run()
  const { tenantUserAsyncLocal } = await import('$lib/server/db/tenant-context')
  const { appDbAsyncLocal, withDbUser } = await import('$lib/server/db')
  if (tenantUserAsyncLocal.getStore() === principal.id && appDbAsyncLocal.getStore()) return run()
  return withDbUser(principal.id, () => run())
}
