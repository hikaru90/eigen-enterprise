import { describe, expect, it } from 'vitest'
import { ORCHESTRATOR_JOURNEY_PROMPT, ORCHESTRATOR_PERSONA_PROMPT } from '../../../../modules/orchestrator/brain'
import { AGENT_SYSTEM_PROMPT } from './agent-loop'

/**
 * The nucleus chatbox talks to /api/chat, whose agent runs on
 * AGENT_SYSTEM_PROMPT. The journey PROTOCOL rides along on both system
 * prompts — but the proactive onboarding ask must NOT: the founding interview
 * (tone of voice, name, positioning) lives in the welcome wizard
 * (src/lib/server/onboarding/founding.ts). Chat surfaces never ask
 * onboarding questions; they only follow active-journey context blocks.
 */

/** The retired proactive journey seed — kept as literals for regression pins. */
const RETIRED_SEED_FRAGMENTS = [/tone of voice FIRST/u, /One question at a time/u, /open the brand journey/u]

describe('agent system prompt journey contract', () => {
  it('carries the journey marker protocol', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain(ORCHESTRATOR_JOURNEY_PROMPT)
    expect(AGENT_SYSTEM_PROMPT).toMatch(/journey context block/)
    expect(AGENT_SYSTEM_PROMPT).toMatch(/append exactly/)
  })

  it('never asks onboarding questions from chat (regression pin)', () => {
    for (const fragment of RETIRED_SEED_FRAGMENTS) {
      expect(AGENT_SYSTEM_PROMPT).not.toMatch(fragment)
      expect(ORCHESTRATOR_PERSONA_PROMPT).not.toMatch(fragment)
    }
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
 * engine runs on ORCHESTRATOR_PERSONA_PROMPT — the journey protocol must ride
 * along there too, or the harness path loses active-journey handling.
 */
describe('harness runtime journey contract', () => {
  it('carries the journey protocol in the orchestrator persona prompt', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain(ORCHESTRATOR_JOURNEY_PROMPT)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/journey context block/)
  })
})
