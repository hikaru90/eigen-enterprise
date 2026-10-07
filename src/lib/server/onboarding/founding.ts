import { KERNEL_EVENT_SOURCE } from '$lib/kernel/cloudevents'
import { emitKernelEvent, type EventSink } from '$lib/kernel/events'
import {
  cloneJourneyState,
  initialJourneyState,
  type JourneyRow,
  type JourneyStore,
} from '$lib/kernel/playbook'
import type { KernelRegistry } from '$lib/kernel/registry'
import {
  executeStepArtifacts,
  ORCHESTRATOR_AGENT_ID,
  WEBSITE_FOUNDING_JOURNEY,
} from '../../../../modules/orchestrator/brain'

/**
 * The welcome wizard's founding interview, server-side. The wizard collects
 * tone of voice, company name, and positioning — the questions that used to
 * leak into the nucleus chat (modules/orchestrator/brain.ts persona). Here the
 * answers become the website-founding journey (fully captured — onboarding IS
 * the interview) and the journey artifacts execute through the kernel registry
 * under ORCHESTRATOR_PRINCIPAL: permissions, audit, and the approval gate all
 * apply for real. Pending publishes stay 'approval_pending' and retry on later
 * submissions or chat turns — the same deterministic control flow as the chat
 * journey driver, via the shared executeStepArtifacts().
 */

export type FoundingInterviewAnswers = {
  tone?: string
  companyName?: string
  positioning?: string
}

export type FoundingRecordResult =
  | { skipped: true }
  | {
      skipped: false
      journeyId: string
      /** Artifacts currently in 'executed' state (creates + completed publishes). */
      executed: number
      /** Artifacts waiting on an owner approval decision (publishes). */
      approvalPending: number
      /** True when every artifact executed and the journey closed. */
      completed: boolean
    }

export type FoundingInterviewDeps = {
  registry: KernelRegistry
  journeys: JourneyStore
  eventSink: EventSink
  /** Traceability only (journeys are per kind): e.g. `onboarding:<userId>`. */
  sessionId: string
}

export type FoundingInterviewCall = FoundingInterviewDeps & {
  answers: FoundingInterviewAnswers
}

export async function recordFoundingInterview(
  call: FoundingInterviewCall,
): Promise<FoundingRecordResult> {
  const { answers, registry, journeys, eventSink, sessionId } = call
  const tone = answers.tone?.trim() ?? ''
  const companyName = answers.companyName?.trim() ?? ''
  const positioning = answers.positioning?.trim() ?? ''
  if (!tone && !companyName && !positioning) return { skipped: true }

  const existing = await journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
  const row: JourneyRow =
    existing ?? (await journeys.create(WEBSITE_FOUNDING_JOURNEY.kind, initialJourneyState(sessionId)))

  const state = cloneJourneyState(row.state)
  // Form semantics: the submitted answers ARE the recorded answers (the chat
  // driver appends verbatim; a wizard re-submission replaces).
  state.answers = { tone, company_name: companyName, positioning }
  state.captured = WEBSITE_FOUNDING_JOURNEY.steps.map((step) => step.id)
  state.stepIndex = WEBSITE_FOUNDING_JOURNEY.steps.length

  const { allExecuted } = await executeStepArtifacts({
    registry,
    spec: WEBSITE_FOUNDING_JOURNEY,
    state,
  })

  const executed = state.artifacts.filter((r) => r.status === 'executed').length
  const approvalPending = state.artifacts.filter((r) => r.status === 'approval_pending').length

  if (allExecuted) {
    await journeys.updateState(row.id, state, 'completed')
    await emitKernelEvent(eventSink, {
      type: 'journey.completed',
      principalId: ORCHESTRATOR_AGENT_ID,
      source: KERNEL_EVENT_SOURCE,
      payload: { journeyId: row.id, kind: row.kind },
    })
  } else {
    await journeys.updateState(row.id, state)
  }

  return {
    skipped: false,
    journeyId: row.id,
    executed,
    approvalPending,
    completed: allExecuted,
  }
}
