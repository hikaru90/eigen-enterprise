import { describe, expect, it } from 'vitest'
import { createAdminTools, kernelManifest } from '$lib/kernel/admin-tools'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import {
  ORCHESTRATOR_JOURNEY_PROMPT,
  ORCHESTRATOR_PERSONA_PROMPT,
  ORCHESTRATOR_PRINCIPAL,
  orchestratorAgentConfig,
} from './brain'

/** The retired chat-opened journey seed — kept as a literal for regression pins. */
const OLD_OPENING_QUESTION =
  'Before I build anything: which three words should describe your company’s tone of voice?'

describe('orchestrator persona: where results live', () => {
  it('tells the agent to answer "where is it" with a working link from website.site_info', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('website.site_info')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/give the link/i)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/never tell them to set up a domain/i)
  })
})

describe('orchestrator persona prompt', () => {
  it('keeps the orchestrator identity lines', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(
      /You are the orchestrator: the general assistant of this company\./,
    )
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/kernel tools/)
  })

  it('tells the agent to fix tool errors itself and only surface what it cannot fix', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('TOOL ERRORS')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('kernel.module_activate')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('kernel.module_list')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/never internal error codes/)
  })

  it('the orchestrator principal can see and run the module admin tools (admin role)', async () => {
    const activations = new InMemoryActivationStore()
    const modules = new ModuleRegistry(activations)
    const registry = new KernelRegistry({ activationStore: activations })
    modules.register(kernelManifest)
    await activations.set('kernel', true)
    const approvals = Object.assign(new InMemoryApprovalStore(), { list: async () => [] })
    for (const t of createAdminTools({ modules, activations, approvals })) registry.register(t)
    const runtime = new AgentRuntime({
      registry,
      isToolActive: (name) => modules.isToolActive(name),
      eventSink: new InMemoryEventSink(),
      rolesFor: () => ORCHESTRATOR_PRINCIPAL.roles,
    })
    runtime.registerAgent(orchestratorAgentConfig())
    const names = (await runtime.listAgentTools(ORCHESTRATOR_PRINCIPAL.id)).map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['kernel.module_list', 'kernel.module_activate']))
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

  it('takes the orchestrator posture: route to modules, never interview', () => {
    // Owner directive: the general chat must present what the company CAN do
    // (the modules) and route — not run a module's multi-step intake itself.
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/you route, you do not interview/)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/mission control, not a questionnaire/)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/memory, website, brand, email, repo/)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/hand off/)
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
