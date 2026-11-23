import { randomUUID } from 'node:crypto'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import type { MemberRole } from '$lib/server/auth/roles'

/**
 * The org chart, the co-worker profile and Settings → Co-workers
 * (plan/phase-ai-coworkers.md C5) are clients of the coworkers.* and org.*
 * registry tools: every read and change runs through the kernel as the
 * signed-in person with their real kernel roles (permission-checked,
 * audited), never around it.
 *
 * Approvals: an owner's or admin's click IS their decision (D11, as ownerRun
 * and Settings → AI's daily cap do): when the tool waits for approval —
 * coworkers.create and coworkers.remove always do, the others when the
 * approval mode gates them — the click is recorded as their approval and the
 * tool runs. A member cannot decide approvals, so their change stays waiting
 * (KernelError approval_required) until an owner or admin decides it; the page
 * says so (`isWaitingForApproval`).
 */

export type PersonRunner = <T>(user: { id: string }, tool: string, input: unknown) => Promise<T>

export class NotAMemberError extends Error {
  constructor(userId: string) {
    super(`No member ${userId}: the org chart and co-workers are read and changed by a member of the company.`)
    this.name = 'NotAMemberError'
  }
}

export const personRun: PersonRunner = async <T>(user: { id: string }, tool: string, input: unknown): Promise<T> => {
  const [{ getUserRole, isAdminRole, kernelRolesFor }, { appKernel }, { ensureSystemModulesActive }] = await Promise.all([
    import('$lib/server/auth/user-role'),
    import('$lib/server/boot'),
    import('../../../../modules/index'),
  ])
  const role: MemberRole | null = await getUserRole(user.id)
  if (!role) throw new NotAMemberError(user.id)
  const k = await appKernel()
  await ensureSystemModulesActive(k)
  const ctx = (): ToolContext => ({
    principal: { id: user.id, kind: 'human', roles: kernelRolesFor(role) },
    requestId: randomUUID(),
  })
  try {
    return (await k.registry.execute(tool, input, ctx())) as T
  } catch (err) {
    const approvalId = isWaitingForApproval(err) ? err.details?.approvalId : undefined
    if (typeof approvalId !== 'string' || !isAdminRole(role)) throw err
    const { decideApprovalAsOwner } = await import('$lib/server/approvals/owner-decision')
    await decideApprovalAsOwner(k.registry, user, approvalId, 'approved')
    return (await k.registry.execute(tool, input, ctx())) as T
  }
}

/** The tool is waiting for an owner's or admin's approval. */
export function isWaitingForApproval(err: unknown): err is KernelError {
  return err instanceof KernelError && err.code === 'approval_required'
}
