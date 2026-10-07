import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATOR_JOURNEY_PROMPT,
  ORCHESTRATOR_PERSONA_PROMPT,
  orchestratorAgentConfig,
} from './brain'

/** The retired chat-opened journey seed — kept as a literal for regression pins. */
const OLD_OPENING_QUESTION =
  'Before I build anything: which three words should describe your company’s tone of voice?'

describe('orchestrator persona prompt', () => {
  it('keeps the orchestrator identity lines', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(
      /You are the orchestrator: the general assistant of this company\./,
    )
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/kernel tools/)
  })

  it('never opens the onboarding journey from chat (onboarding owns the interview)', () => {
    // Regression pin: the persona used to instruct the agent to ask the
    // founding question verbatim on "founding-shaped" requests — an LLM
    // judgment that leaked onboarding questions into ordinary chat ("what api
    // are you using?" → tone-of-voice question). The founding interview now
    // lives in the welcome wizard; chat journeys are started there, server-side.
    expect(ORCHESTRATOR_PERSONA_PROMPT).not.toContain(OLD_OPENING_QUESTION)
    expect(ORCHESTRATOR_PERSONA_PROMPT).not.toMatch(/open the brand journey/)
    expect(ORCHESTRATOR_PERSONA_PROMPT).not.toMatch(/founding-shaped/)
    expect(ORCHESTRATOR_JOURNEY_PROMPT).not.toContain(OLD_OPENING_QUESTION)
  })

  it('still teaches the step-capture marker protocol for active journeys', () => {
    // Journeys opened by onboarding can still be mid-flight on chat surfaces;
    // the agent must honor the context block's capture protocol when one is.
    expect(ORCHESTRATOR_JOURNEY_PROMPT).toMatch(/journey context block/)
    expect(ORCHESTRATOR_JOURNEY_PROMPT).toMatch(/append exactly/)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain(ORCHESTRATOR_JOURNEY_PROMPT)
  })
})

describe('orchestratorAgentConfig', () => {
  it('stays the zero-privilege harness config', () => {
    const config = orchestratorAgentConfig()
    expect(config).toMatchObject({
      id: 'orchestrator',
      loopEngine: 'builtin-json',
      toolScope: 'all',
      enabled: true,
    })
  })
})
