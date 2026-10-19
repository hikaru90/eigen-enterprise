import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { bootApp } from '$lib/server/boot'
import {
  BRIEFING_BOOTSTRAP_MESSAGES,
  handleAgentChatPost,
  type AgentChatPostBody,
} from '$lib/server/chat/handle-agent-chat-post'
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

  if (bootstrap && !onboardingHandoff && !briefingPeriod) {
    error(400, 'bootstrap requires briefingPeriod')
  }

  if (bootstrap && !onboardingHandoff && briefingPeriod && !BRIEFING_BOOTSTRAP_MESSAGES[briefingPeriod]) {
    error(400, 'Invalid briefingPeriod')
  }

  const boot = await bootApp()

  return handleAgentChatPost(event, b, {
    sessionMode: 'default',
    logTag: 'api/chat',
    dispatch: (sessionId, message, sinks, userId) =>
      onboardingHandoff
        ? boot.orchestrator.runtime.dispatchOnboardingHandoff(sessionId, sinks, { llmUserId: userId })
        : boot.orchestrator.runtime.dispatch(ORCHESTRATOR_AGENT_ID, sessionId, message, sinks, {
            llmUserId: userId,
          }),
    resolveAgentUserMessage: ({ bootstrap, message, briefingPeriod: period }) => {
      // The hand-off input is assembled by the runtime (onboarding context + instruction).
      if (onboardingHandoff) return ''
      if (bootstrap && period && BRIEFING_BOOTSTRAP_MESSAGES[period]) {
        return BRIEFING_BOOTSTRAP_MESSAGES[period]
      }
      return message
    },
  })
}
