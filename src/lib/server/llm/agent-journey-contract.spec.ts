import { describe, expect, it } from 'vitest'
import { ORCHESTRATOR_JOURNEY_PROMPT, ORCHESTRATOR_PERSONA_PROMPT } from '../../../../modules/orchestrator/brain'
import { AGENT_SYSTEM_PROMPT } from './agent-loop'

/**
 * The nucleus chatbox talks to /api/chat, whose agent runs on
 * AGENT_SYSTEM_PROMPT — the onboarding journey seed only reaches the surface
 * if the persona (with the journey) is part of that prompt.
 */
describe('agent system prompt journey contract', () => {
  it('carries the orchestrator journey seed', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain(ORCHESTRATOR_JOURNEY_PROMPT)
    expect(AGENT_SYSTEM_PROMPT).toMatch(/tone of voice FIRST/)
    expect(AGENT_SYSTEM_PROMPT).toMatch(/One question at a time/)
  })

  it('keeps the memory-tool operating rules after the persona preamble', () => {
    expect(AGENT_SYSTEM_PROMPT).toMatch(
      /You are a text interface over the user's personal memory tools\./,
    )
    const personaEnd = AGENT_SYSTEM_PROMPT.indexOf('You are a text interface')
    const rulesEnd = AGENT_SYSTEM_PROMPT.indexOf('=== RULES ===')
    expect(personaEnd).toBeGreaterThan(0)
    expect(rulesEnd).toBeGreaterThan(personaEnd)
  })
})

/**
 * /api/chat now dispatches through the kernel AgentRuntime, whose builtin-json
 * engine runs on ORCHESTRATOR_PERSONA_PROMPT — the journey must ride along
 * there too, or the harness path loses the onboarding seed.
 */
describe('harness runtime journey contract', () => {
  it('carries the journey seed in the orchestrator persona prompt', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain(ORCHESTRATOR_JOURNEY_PROMPT)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/tone of voice FIRST/)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/One question at a time/)
  })
})
