import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATOR_JOURNEY_PROMPT,
  ORCHESTRATOR_PERSONA_PROMPT,
  orchestratorAgentConfig,
} from './brain'

describe('orchestrator persona prompt', () => {
  it('keeps the orchestrator identity lines', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(
      /You are the orchestrator: the general assistant of this company\./,
    )
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/kernel tools/)
  })

  it('seeds the onboarding brand journey for founding-shaped requests', () => {
    expect(ORCHESTRATOR_JOURNEY_PROMPT).toMatch(/no brand or website content yet/)
    expect(ORCHESTRATOR_JOURNEY_PROMPT).toMatch(/asks for a website/)
    expect(ORCHESTRATOR_JOURNEY_PROMPT).toMatch(/open the brand journey/)
    expect(ORCHESTRATOR_JOURNEY_PROMPT).toMatch(/tone of voice FIRST/)
  })

  it('keeps the journey conversational: one question at a time, no lists unless asked', () => {
    expect(ORCHESTRATOR_JOURNEY_PROMPT).toMatch(/One question at a time/)
    expect(ORCHESTRATOR_JOURNEY_PROMPT).toMatch(/no lists unless asked/)
  })

  it('includes the journey seed in the persona system prompt', () => {
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
