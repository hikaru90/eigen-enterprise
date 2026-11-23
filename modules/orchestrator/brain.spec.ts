import { describe, expect, it } from 'vitest'
import { createAdminTools, kernelManifest } from '$lib/kernel/admin-tools'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import * as brain from './brain'
import {
  ORCHESTRATOR_AGENT_ID,
  ORCHESTRATOR_JOURNEY_PROMPT,
  ORCHESTRATOR_PERSONA_PROMPT,
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

describe('orchestrator persona: every tool through ee (plan/shared-memory-voice-agent-tools.md §3)', () => {
  it('teaches the ee discovery path (namespaces → list → help → run) before "I cannot"', () => {
    for (const step of ['"namespaces"', '"list","--namespace"', '"help"', '"run"']) expect(ORCHESTRATOR_PERSONA_PROMPT).toContain(step)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/find one before saying you cannot/i)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/ee tool is the company CLI, run as this person/)
  })
})

describe('orchestrator persona: reach beyond modules (Contribute d80e155d)', () => {
  it('answers "which model are you" from kernel.whoami, never "I do not know"', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('kernel.whoami')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/never guess/i)
  })

  it('knows it reaches settings through settings.get / settings.update, and that a change waits for the owner', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('settings.get')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('settings.update')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/always waits for the owner/i)
    // Not limited to naming modules any more.
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/not only (its )?modules/i)
  })
})

describe('orchestrator persona: the website is public, internal documents go to Drive or Memory › Documents (Contribute)', () => {
  it('routes internal documents away from the website and names the tools for them', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('WHERE CONTENT GOES')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/website is the company’s public website/i)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/pitch decks, project descriptions, funding/i)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/never become website pages, not even private ones/i)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('drive.create_document')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('memory.create_text_file')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('Memory › Documents')
  })

  it('names Drive among the modules it can offer', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/name the modules \([^)]*\bdrive\b[^)]*\)/)
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

  it('never re-enables a plugin a person switched off: only never-activated ones (owner, 2026-11-12)', () => {
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/never switch back on a plugin a person switched off/i)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('"switchedOff":true')
    expect(ORCHESTRATOR_PERSONA_PROMPT).toContain('Settings → Plugins')
  })

  it('the brain acting for an admin sees the module admin tools; acting for a member it does not (CB3)', async () => {
    const activations = new InMemoryActivationStore()
    const modules = new ModuleRegistry(activations)
    const registry = new KernelRegistry({ activationStore: activations })
    modules.register(kernelManifest)
    await activations.set('kernel', true)
    const approvals = Object.assign(new InMemoryApprovalStore(), { list: async () => [] })
    for (const t of createAdminTools({ tool: () => undefined, modules, activations, approvals })) registry.register(t)
    const runtime = new AgentRuntime({
      registry,
      isToolActive: (name) => modules.isToolActive(name),
      eventSink: new InMemoryEventSink(),
    })
    runtime.registerAgent(orchestratorAgentConfig())
    const forAdmin = (await runtime.listAgentTools(ORCHESTRATOR_AGENT_ID, { id: 'a', roles: ['admin', 'member'] })).map((t) => t.name)
    expect(forAdmin).toEqual(expect.arrayContaining(['kernel.module_list', 'kernel.module_activate']))
    const forMember = (await runtime.listAgentTools(ORCHESTRATOR_AGENT_ID, { id: 'm', roles: ['member'] })).map((t) => t.name)
    expect(forMember).toEqual([])
  })

  it('there is no admin agent principal any more: the brain only acts as a person (CB3)', () => {
    expect('ORCHESTRATOR_PRINCIPAL' in brain).toBe(false)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/YOU ACT AS THE PERSON/)
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
    // Platform step 1: the owner-facing cut; the agent's own tools are not offered as modules.
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/website, drive, email, brand, memory, chat-gateway, recap/)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/repo and roadmap tools are not modules to offer/)
    expect(ORCHESTRATOR_PERSONA_PROMPT).toMatch(/hand off/)
  })
})

describe('orchestratorAgentConfig', () => {
  it('stays the zero-privilege harness config', () => {
    const config = orchestratorAgentConfig()
    expect(config).toMatchObject({
      id: 'orchestrator',
      loopEngine: 'durable',
      toolScope: 'all',
      enabled: true,
    })
  })
})
