import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { KERNEL_EVENT_SOURCE } from '$lib/kernel/cloudevents'
import { emitKernelEvent } from '$lib/kernel/events'
import { approvalContinuationMessage, findApprovalAsOwner } from '$lib/server/approvals/owner-decision'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { bootApp } from '$lib/server/boot'
import {
  BRIEFING_BOOTSTRAP_MESSAGES,
  handleAgentChatPost,
  type AgentChatPostBody,
} from '$lib/server/chat/handle-agent-chat-post'
import { redactForLog } from '$lib/server/observability/redact-for-log'
import { ORCHESTRATOR_AGENT_ID } from '../../../../modules/orchestrator/brain'

/**
 * The nucleus chatbox speaks through the harness proper (plan/phase-1b):
 * one path — AgentRuntime.dispatch for the orchestrator agent. Role gate:
 * ANY authenticated user may talk to the orchestrator (checked in
 * handleAgentChatPost); the orchestrator principal carries 'admin' + 'agent'
 * for its kernel tool surface (runtime rolesFor, set at bootstrap). The boot
 * is resolved exactly like src/lib/server/boot.ts — memoized, single kernel,
 * never a second composition.
 */
export const POST: RequestHandler = async (event) => {
  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    error(400, 'Invalid JSON')
  }

  const b =
    typeof body === 'object' && body ? (body as AgentChatPostBody) : ({} as AgentChatPostBody)

  const bootstrap = b.bootstrap === true
  const briefingPeriod = typeof b.briefingPeriod === 'string' ? b.briefingPeriod.trim() : ''
  // Assisted-onboarding hand-off: the agent's first turn after the scripted
  // setup. Always a bootstrap (no user speech); the runtime builds the input.
  const onboardingHandoff = b.onboardingHandoff === true

  if (onboardingHandoff && !bootstrap) {
    error(400, 'onboardingHandoff requires bootstrap')
  }

  // Owner-decision continuation: after Approve/Deny on a card, the agent gets a
  // system turn naming the decision (no user speech) and continues the work.
  const approvalContinuation =
    typeof b.approvalContinuation === 'string' && b.approvalContinuation.trim()
      ? b.approvalContinuation.trim()
      : null
  if (b.approvalContinuation !== undefined && (!approvalContinuation || !bootstrap)) {
    error(400, 'approvalContinuation requires bootstrap and an approval id')
  }

  if (bootstrap && !onboardingHandoff && !approvalContinuation && !briefingPeriod) {
    error(400, 'bootstrap requires briefingPeriod')
  }

  if (bootstrap && !onboardingHandoff && briefingPeriod && !BRIEFING_BOOTSTRAP_MESSAGES[briefingPeriod]) {
    error(400, 'Invalid briefingPeriod')
  }

  const boot = await bootApp()

  let continuationMessage: string | null = null
  if (approvalContinuation) {
    const user = event.locals.user
    if (!user) error(401, 'Unauthorized')
    if (!(await isUserAdmin(user.id))) error(403, 'Forbidden')
    const approval = await findApprovalAsOwner(boot.kernel.registry, user, approvalContinuation)
    if (!approval) error(404, 'Approval request not found')
    if (approval.status === 'pending') error(409, 'Approval request is not decided yet')
    continuationMessage = approvalContinuationMessage(approval)
  }

  return handleAgentChatPost(event, b, {
    sessionMode: 'default',
    logTag: 'api/chat',
    dispatch: (sessionId, message, sinks, userId) =>
      onboardingHandoff
        ? boot.orchestrator.runtime.dispatchOnboardingHandoff(sessionId, sinks, { llmUserId: userId })
        : boot.orchestrator.runtime.dispatch(ORCHESTRATOR_AGENT_ID, sessionId, message, sinks, {
            llmUserId: userId,
          }),
    // Harness/LLM failures end the turn with a fixed human message; the real
    // error lands here — the operator-visible kernel event log (redacted).
    recordFailure: async (record) => {
      await emitKernelEvent(boot.kernel.eventSink, {
        type: 'harness.turn_failed',
        principalId: ORCHESTRATOR_AGENT_ID,
        source: KERNEL_EVENT_SOURCE,
        payload: redactForLog(record),
      })
    },
    resolveAgentUserMessage: ({ bootstrap, message, briefingPeriod: period }) => {
      // The hand-off input is assembled by the runtime (onboarding context + instruction).
      if (onboardingHandoff) return ''
      if (continuationMessage) return continuationMessage
      if (bootstrap && period && BRIEFING_BOOTSTRAP_MESSAGES[period]) {
        return BRIEFING_BOOTSTRAP_MESSAGES[period]
      }
      return message
    },
  })
}
