import type { OrchestratorEngineId } from './engine-choice'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import type { LoopEngine } from '$lib/kernel/engine'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryJourneyStore } from '$lib/kernel/playbook'
import { KernelRegistry } from '$lib/kernel/registry'
import {
  JourneyAwareAgentRuntime,
  ORCHESTRATOR_AGENT_ID,
  WEBSITE_FOUNDING_JOURNEY,
  orchestratorAgentConfig,
} from './brain'
import {
  ONBOARDING_HANDOFF_INSTRUCTION,
  ONBOARDING_START_WEBSITE_MARKER,
  type OnboardingFacts,
} from './onboarding-context'

/**
 * Assisted onboarding hand-off: after the scripted setup, the ORCHESTRATOR
 * AGENT speaks first (with the onboarding context block) and opens the
 * website journey itself via the exact start marker. Fake engines, real
 * runtime + registry + journey store.
 */

type Fx = {
  runtime: JourneyAwareAgentRuntime
  journeys: InMemoryJourneyStore
  inputs: Array<{ engine: string; input: string }>
  script: string[]
  facts: { current: OnboardingFacts | null }
}

const handedOff: OnboardingFacts = {
  welcomeCompleted: true,
  adminAccount: true,
  email: true,
  aiProvider: true,
  website: 'not_started',
}

function fixture(
  options: { pin?: OrchestratorEngineId | null; recorded?: OrchestratorEngineId | null } = {},
): Fx {
  const sink = new InMemoryEventSink()
  const registry = new KernelRegistry({
    eventSink: sink,
    approvalPolicy: new StaticApprovalPolicy(new Set()),
    approvalStore: new InMemoryApprovalStore(),
    vcsCommitter: null,
  })
  const inputs: Fx['inputs'] = []
  const script: string[] = []
  const facts: Fx['facts'] = { current: handedOff }
  const journeys = new InMemoryJourneyStore()

  const fake = (engine: string): LoopEngine => ({
    run: async (_sessionId, input) => {
      inputs.push({ engine, input })
      const reply = script.shift()
      if (reply === undefined) throw new Error('fake engine: script exhausted')
      return reply
    },
  })

  const runtime = new JourneyAwareAgentRuntime({
    registry,
    isToolActive: async () => true,
    eventSink: sink,
    rolesFor: () => ['admin', 'agent'],
    journeys,
    spec: WEBSITE_FOUNDING_JOURNEY,
    onboardingFacts: async (llmUserId) => (llmUserId ? facts.current : null),
    enginePin: options.pin ?? null,
    recordedEngineFor: async () => options.recorded ?? null,
  })
  runtime.registerEngine('builtin-json', fake('builtin-json'))
  runtime.registerEngine('durable', fake('durable'))
  runtime.registerAgent(orchestratorAgentConfig())
  return { runtime, journeys, inputs, script, facts }
}

describe('onboarding hand-off — the agent takes over after the scripted setup', () => {
  it('the first turn comes from the orchestrator agent, prompted with the onboarding context', async () => {
    const fx = fixture()
    fx.script.push('You did it — your company is set up. Shall we start with your website?')

    const reply = await fx.runtime.dispatchOnboardingHandoff('s1', undefined, { llmUserId: 'u1' })

    expect(reply).toBe('You did it — your company is set up. Shall we start with your website?')
    expect(fx.inputs).toHaveLength(1)
    expect(fx.inputs[0]!.input.startsWith('[company onboarding context]')).toBe(true)
    expect(fx.inputs[0]!.input).toContain(ONBOARDING_HANDOFF_INSTRUCTION)
    // The hand-off never opens the journey by itself — the owner answers first.
    expect(await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)).toBeNull()
  })

  it('the hand-off itself marks the end of the scripted setup (the wizard stamp may still be in flight)', async () => {
    const fx = fixture()
    fx.facts.current = { ...handedOff, welcomeCompleted: false }
    fx.script.push('You did it.')
    await expect(fx.runtime.dispatchOnboardingHandoff('s1', undefined, { llmUserId: 'u1' })).resolves.toBe('You did it.')
  })

  it('fails loud when the hand-off is requested but the website is already under way', async () => {
    const fx = fixture()
    fx.facts.current = { ...handedOff, website: 'in_progress' }
    await expect(fx.runtime.dispatchOnboardingHandoff('s1', undefined, { llmUserId: 'u1' })).rejects.toThrow(
      /assisted onboarding is not active/,
    )
    expect(fx.inputs).toHaveLength(0)
  })

  it('next turns carry the context block until the agent starts the website', async () => {
    const fx = fixture()
    fx.script.push('What would you like instead?')
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 's1', 'not yet', undefined, { llmUserId: 'u1' })
    expect(fx.inputs[0]!.input.startsWith('[company onboarding context]')).toBe(true)
    expect(fx.inputs[0]!.input.endsWith('not yet')).toBe(true)
    expect(await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)).toBeNull()
  })

  it('the agent’s exact start marker opens the website journey; the marker never reaches the user', async () => {
    const fx = fixture()
    fx.script.push(`Great — what’s your company called?\n${ONBOARDING_START_WEBSITE_MARKER}`)

    const reply = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 's1', 'yes, website', undefined, {
      llmUserId: 'u1',
    })

    expect(reply).toBe('Great — what’s your company called?')
    const journey = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(journey).not.toBeNull()
    // The "yes" is not an answer: the journey starts empty, at step 1.
    expect(journey!.state.answers).toEqual({})
    expect(journey!.state.stepIndex).toBe(0)

    // Next turn: the journey drives (journey context, the name is captured verbatim).
    fx.facts.current = { ...handedOff, website: 'in_progress' }
    fx.script.push('Nice.')
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 's1', 'Kindred Digital Labs', undefined, { llmUserId: 'u1' })
    expect(fx.inputs[1]!.input.startsWith('[company journey context')).toBe(true)
    const after = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(after!.state.answers.company_name).toBe('Kindred Digital Labs')
  })

  it('no onboarding block for non-human turns or once the website is done', async () => {
    const fx = fixture()
    fx.script.push('hi', 'hi')
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 's1', 'hello')
    fx.facts.current = { ...handedOff, website: 'done' }
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 's1', 'hello', undefined, { llmUserId: 'u1' })
    expect(fx.inputs.map((i) => i.input)).toEqual(['hello', 'hello'])
  })
})

describe('per-dispatch engine choice (both engines get the same onboarding context)', () => {
  it('runs the engine recorded for the conversing user’s provider', async () => {
    const fx = fixture({ recorded: 'durable' })
    fx.script.push('hey')
    await fx.runtime.dispatchOnboardingHandoff('s1', undefined, { llmUserId: 'u1' })
    expect(fx.inputs[0]!.engine).toBe('durable')
    expect(fx.inputs[0]!.input.startsWith('[company onboarding context]')).toBe(true)
  })

  it('a recorded builtin-json (subscription sign-in) stays builtin-json', async () => {
    const fx = fixture({ recorded: 'builtin-json' })
    fx.script.push('hey')
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 's1', 'hi', undefined, { llmUserId: 'u1' })
    expect(fx.inputs[0]!.engine).toBe('builtin-json')
  })

  it('the operator pin wins', async () => {
    const fx = fixture({ pin: 'builtin-json', recorded: 'durable' })
    fx.script.push('hey')
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 's1', 'hi', undefined, { llmUserId: 'u1' })
    expect(fx.inputs[0]!.engine).toBe('builtin-json')
  })
})
