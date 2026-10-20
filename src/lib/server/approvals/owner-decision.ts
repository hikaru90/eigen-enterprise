import { randomUUID } from 'node:crypto'
import { approvalActionLabel } from '$lib/chat/approval-copy'
import type { ApprovalRequest } from '$lib/kernel/approvals'
import type { ToolContext } from '$lib/kernel/types'

/**
 * Owner approval decisions from the chat surface. Every read and write goes
 * through the kernel admin tools (kernel.approvals_list / approvals_decide)
 * as the signed-in human, so permission and audit apply — no side channel
 * into the approval store. Callers enforce admin first (requireAdmin).
 */

export type KernelExecutor = {
  execute(name: string, input: unknown, ctx: ToolContext): Promise<unknown>
}

function ownerContext(user: { id: string }): ToolContext {
  return { principal: { id: user.id, kind: 'human', roles: ['admin'] }, requestId: randomUUID() }
}

export async function findApprovalAsOwner(
  registry: KernelExecutor,
  user: { id: string },
  approvalId: string,
): Promise<ApprovalRequest | null> {
  const all = (await registry.execute(
    'kernel.approvals_list',
    {},
    ownerContext(user),
  )) as ApprovalRequest[]
  return all.find((r) => r.id === approvalId) ?? null
}

export type OwnerDecisionOutcome =
  | { kind: 'decided'; approval: ApprovalRequest }
  | { kind: 'already_decided'; approval: ApprovalRequest }
  | { kind: 'not_found' }

export async function decideApprovalAsOwner(
  registry: KernelExecutor,
  user: { id: string },
  approvalId: string,
  decision: 'approved' | 'denied',
): Promise<OwnerDecisionOutcome> {
  const existing = await findApprovalAsOwner(registry, user, approvalId)
  if (!existing) return { kind: 'not_found' }
  if (existing.status !== 'pending') return { kind: 'already_decided', approval: existing }
  const approval = (await registry.execute(
    'kernel.approvals_decide',
    { approval_id: approvalId, decision },
    ownerContext(user),
  )) as ApprovalRequest
  return { kind: 'decided', approval }
}

/**
 * The system turn the agent receives after the owner decides a card, so it
 * sees the decision and continues: re-runs the gated step when approved
 * (journey artifacts retry on every turn; a direct tool call is re-issued),
 * or drops it when denied.
 */
export function approvalContinuationMessage(approval: ApprovalRequest): string {
  const action = `${approvalActionLabel(approval.toolName)} (tool ${approval.toolName}, approval ${approval.id})`
  if (approval.status === 'approved') {
    return `[Owner decision] The owner approved the pending request: ${action}. Run it now if it is still needed — call the tool again with the same input — then tell the owner in one or two sentences what happened.`
  }
  if (approval.status === 'denied') {
    return `[Owner decision] The owner denied the pending request: ${action}. Do not run it. Acknowledge the decision briefly and continue with what is still open.`
  }
  throw new Error(`approval ${approval.id} is still pending; there is no decision to continue from`)
}
