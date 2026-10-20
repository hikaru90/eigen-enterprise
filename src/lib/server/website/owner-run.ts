import { appKernel } from '$lib/server/boot'
import { randomUUID } from 'node:crypto'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { decideApprovalAsOwner } from '$lib/server/approvals/owner-decision'
import { bootstrapKernel, ensureSystemModulesActive } from '../../../../modules/index'
import { AppUserError } from '../../../../modules/website/apps/contract'

/**
 * Website pages run every read and change through the kernel registry as the
 * signed-in owner (permission-checked, audited). The owner's click IS their
 * decision: when the approval mode gates the tool, the click is recorded as
 * their approval, then the tool runs (D11: owner clicks are human actions).
 */

function ownerCtx(user: { id: string }): ToolContext {
  return { principal: { id: user.id, kind: 'human', roles: ['admin'] }, requestId: randomUUID() }
}

export async function ownerRun<T>(user: { id: string }, tool: string, input: unknown): Promise<T> {
  const k = await appKernel()
  await ensureSystemModulesActive(k)
  try {
    return (await k.registry.execute(tool, input, ownerCtx(user))) as T
  } catch (err) {
    const approvalId =
      err instanceof KernelError && err.code === 'approval_required'
        ? err.details?.approvalId
        : undefined
    if (typeof approvalId !== 'string') throw err
    await decideApprovalAsOwner(k.registry, user, approvalId, 'approved')
    return (await k.registry.execute(tool, input, ownerCtx(user))) as T
  }
}

/** code ↔ harness ↔ user: a plain sentence for the page; details go to the server log. */
export function plainAppMessage(err: unknown): string {
  if (err instanceof AppUserError) return err.message
  if (err instanceof KernelError) {
    if (err.code === 'permission_denied') return 'Only an admin can do this.'
    if (err.code === 'invalid_input')
      return 'Some of what was entered is not valid. Check it and try again.'
    if (err.code === 'approval_required') return 'This is waiting for your approval in the chat.'
  }
  return 'Something went wrong while deploying. Try again; if it keeps happening, ask in the chat.'
}

export function logAppFailure(tool: string, err: unknown): void {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
  console.error(
    `[website/apps] ${tool} failed: ${err instanceof Error ? err.message : String(err)}${cause}`,
  )
}
