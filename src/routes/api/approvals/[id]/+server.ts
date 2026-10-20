import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { z } from 'zod'
import { decideApprovalAsOwner } from '$lib/server/approvals/owner-decision'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { bootApp } from '$lib/server/boot'

const decisionBody = z.object({ decision: z.enum(['approved', 'denied']) })

/**
 * The owner's Approve / Deny on a chat approval card. Owner/admin only; the
 * decision is recorded through the kernel (kernel.approvals_decide) as the
 * signed-in human. The page then sends the agent a continuation turn
 * (POST /api/chat approvalContinuation) so the gated step re-runs.
 */
export const POST: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    error(400, 'Invalid JSON')
  }
  const parsed = decisionBody.safeParse(body)
  if (!parsed.success) error(400, "decision must be 'approved' or 'denied'")

  const boot = await bootApp()
  const outcome = await decideApprovalAsOwner(
    boot.kernel.registry,
    user,
    event.params.id,
    parsed.data.decision,
  )
  if (outcome.kind === 'not_found') error(404, 'Approval request not found')
  if (outcome.kind === 'already_decided') error(409, `Approval request already ${outcome.approval.status}`)
  return json(outcome.approval)
}
