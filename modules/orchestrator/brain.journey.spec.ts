import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAdminTools, kernelManifest } from '$lib/kernel/admin-tools'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import type { LoopEngine } from '$lib/kernel/engine'
import { KernelError } from '$lib/kernel/errors'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { InMemoryJourneyStore, initialJourneyState } from '$lib/kernel/playbook'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import {
  HARNESS_OBSERVATION_HEADER,
  JourneyAwareAgentRuntime,
  ORCHESTRATOR_AGENT_ID,
  WEBSITE_FOUNDING_JOURNEY,
  executeStepArtifacts,
  orchestratorAgentConfig,
} from './brain'

/**
 * Journey lifecycle tests: pure fakes (no DB, no real LLM). The fake loop
 * engine returns scripted replies (step-capture markers), so the
 * deterministic protocol — verbatim answer capture, artifact execution
 * order, the approval gate, and completion — is pinned end to end against a
 * REAL KernelRegistry (permissions/approval gate/audit apply for real).
 *
 * Journeys are OPENED BY ONBOARDING (src/lib/server/onboarding/founding.ts),
 * never by chat replies — the helper pre-creates the row exactly like the
 * onboarding endpoint does, and one test pins that chat replies (even ones
 * containing the old opening question) open nothing.
 */

/** The retired chat-opened journey seed — kept as a literal for regression pins. */
const OLD_OPENING_QUESTION =
  'Before I build anything: which three words should describe your company’s tone of voice?'

const marker = (stepId: string) => `[[journey:${stepId}:captured]]`

type FakePage = { slug: string; visibility: string; body?: string }

type Fixture = {
  runtime: JourneyAwareAgentRuntime
  journeys: InMemoryJourneyStore
  sink: InMemoryEventSink
  approvals: InMemoryApprovalStore
  engineInputs: string[]
  toolCalls: Array<{ tool: string; input: Record<string, unknown> }>
  pages: Map<string, FakePage>
  script: string[]
}

function fixture(options: { failOnSlug?: string } = {}): Fixture {
  const sink = new InMemoryEventSink()
  const approvals = new InMemoryApprovalStore()
  const pages = new Map<string, FakePage>()
  const toolCalls: Fixture['toolCalls'] = []
  const engineInputs: string[] = []
  const script: string[] = []

  const createPage: ToolDescriptor = {
    name: 'website.create_page',
    module: 'website',
    summary: 'fake create',
    auditClass: 'mutate',
    activity: () => 'Did a test action',
    inputSchema: z.looseObject({ slug: z.string(), body: z.string().optional() }),
    permission: { roles: ['admin', 'agent'] },
    handler: async (_ctx: ToolContext, input: unknown) => {
      const args = input as { slug: string; body?: string }
      toolCalls.push({ tool: 'website.create_page', input: args })
      if (options.failOnSlug === args.slug) throw new Error(`duplicate website slug: ${args.slug}`)
      pages.set(args.slug, { slug: args.slug, visibility: 'private', body: args.body })
      return { slug: args.slug, visibility: 'private' }
    },
  }
  const publishPage: ToolDescriptor = {
    name: 'website.publish_page',
    module: 'website',
    summary: 'fake publish',
    auditClass: 'mutate',
    activity: () => 'Did a test action',
    inputSchema: z.looseObject({ slug: z.string(), visibility: z.string() }),
    permission: { roles: ['admin', 'agent'] },
    handler: async (_ctx: ToolContext, input: unknown) => {
      const args = input as { slug: string; visibility: string }
      toolCalls.push({ tool: 'website.publish_page', input: args })
      const page = pages.get(args.slug)
      if (!page) throw new Error(`unknown website page: ${args.slug}`)
      page.visibility = args.visibility
      return { slug: args.slug, visibility: args.visibility }
    },
  }

  const listPages: ToolDescriptor = {
    name: 'website.list_pages',
    module: 'website',
    summary: 'fake list',
    auditClass: 'read',
    inputSchema: z.looseObject({}),
    permission: { roles: ['admin', 'agent'] },
    handler: async () =>
      [...pages.values()].map((p) => ({ slug: p.slug, visibility: p.visibility })),
  }

  const registry = new KernelRegistry({
    eventSink: sink,
    approvalPolicy: new StaticApprovalPolicy(new Set(['website.publish_page'])),
    approvalStore: approvals,
    vcsCommitter: null,
  })
  registry.register(createPage)
  registry.register(publishPage)
  registry.register(listPages)

  const engine: LoopEngine = {
    run: async (_sessionId, input) => {
      engineInputs.push(input)
      const reply = script.shift()
      if (reply === undefined) throw new Error('fake engine: script exhausted')
      return reply
    },
  }

  const journeys = new InMemoryJourneyStore()
  const runtime = new JourneyAwareAgentRuntime({
    registry,
    isToolActive: async () => true,
    eventSink: sink,
    rolesFor: () => ['admin', 'agent'],
    journeys,
    spec: WEBSITE_FOUNDING_JOURNEY,
  })
  runtime.registerEngine('durable', engine)
  runtime.registerAgent(orchestratorAgentConfig())

  return { runtime, journeys, sink, approvals, engineInputs, toolCalls, pages, script }
}

async function runFoundingJourney(fx: Fixture, sinks?: Parameters<JourneyAwareAgentRuntime['dispatch']>[3]): Promise<string[]> {
  await fx.journeys.create(
    WEBSITE_FOUNDING_JOURNEY.kind,
    initialJourneyState('session-1', WEBSITE_FOUNDING_JOURNEY.specVersion),
  )

  // Phase-2e step order: the boot sequence's seeded greeting asks the company
  // name first — the journey steps match that founding order.
  fx.script.push(`Great — noted.\n${marker('company_name')}`)
  const r1 = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'Kindred Digital Labs', sinks)

  fx.script.push(`Love it.\n${marker('positioning')}`)
  const r2 = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'an AI-native company OS', sinks)

  fx.script.push(`Perfect.\n${marker('tone')}`)
  const r3 = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'warm, direct, technical', sinks)

  return [r1, r2, r3]
}

describe('journey lifecycle (website founding, fake-engine end to end)', () => {
  it('never opens a journey from chat replies — onboarding owns the start (regression pin)', async () => {
    const fx = fixture()
    fx.script.push('Just chatting!')
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'hello there')
    expect(await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)).toBeNull()

    // Even a reply quoting the exact retired opening question creates nothing:
    // the persona no longer asks it, and the driver no longer starts journeys.
    fx.script.push(`Sure!\n${OLD_OPENING_QUESTION}`)
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'i need a website')

    expect(await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)).toBeNull()
  })

  it('abandons a stale journey row (old spec shape) — the turn is a pure orchestrator chat', async () => {
    // The production incident: a pre-versioning journey row (no specVersion)
    // kept injecting "ask the next step's question" context into every chat
    // turn long after the spec had moved on. Stale rows are abandoned, the
    // abandonment is audited, and the turn runs without any journey context.
    const fx = fixture()
    const row = await fx.journeys.create(WEBSITE_FOUNDING_JOURNEY.kind, initialJourneyState('session-1'))

    fx.script.push('Just chatting!')
    const reply = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'hi')

    expect(reply).toBe('Just chatting!')
    expect(fx.engineInputs[0]).not.toContain('[company journey context')
    expect(fx.toolCalls).toEqual([])

    const abandoned = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(abandoned).toBeNull()
    const events = fx.sink.events.filter((e) => e.type === 'journey.abandoned')
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ journeyId: row.id, reason: 'spec_version' })
  })

  it('prepends the journey context block (clearly delimited, with user speech below it)', async () => {
    const fx = fixture()
    await runFoundingJourney(fx)

    // Every turn: journey active — context block on top, user speech last.
    expect(fx.engineInputs[0].startsWith('[company journey context — not user speech]')).toBe(true)
    expect(fx.engineInputs[0]).toContain('step 1/3 (company_name)')
    expect(fx.engineInputs[0].endsWith('Kindred Digital Labs')).toBe(true)
    // Turn 2: collected name is rendered for the model.
    expect(fx.engineInputs[1]).toContain('- company_name: Kindred Digital Labs')
  })

  it('accumulates verbatim answers, strips markers from user-facing replies, and advances steps', async () => {
    const fx = fixture()
    await runFoundingJourney(fx)

    const row = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(row).not.toBeNull()
    expect(row!.state.captured).toEqual(['company_name', 'positioning', 'tone'])
    expect(row!.state.answers).toEqual({
      tone: 'warm, direct, technical',
      company_name: 'Kindred Digital Labs',
      positioning: 'an AI-native company OS',
    })

    // Markers are protocol tokens — never user-visible.
    for (const input of fx.engineInputs.slice(1)) {
      // engine inputs contain markers only via the context protocol line, not raw.
      expect(input.includes('\n[[journey:')).toBe(false)
    }
  })

  it('executes artifacts in spec order with inputs derived from collected answers', async () => {
    const fx = fixture()
    await runFoundingJourney(fx)

    const byTool = fx.toolCalls.map((c) => c.tool)
    // Skeleton after the name + positioning; brand doc last (it needs the tone
    // answer too). The publish is gated BEFORE its handler runs (registry
    // approval gate) — it never reaches this handler-level log; the pending
    // approval request pins it.
    expect(byTool).toEqual([
      'website.create_page', // home
      'website.create_page', // about
      'website.create_page', // contact
      'website.create_page', // brand doc (after tone, the final step)
    ])

    const home = fx.toolCalls[0]!.input
    expect(home).toMatchObject({ slug: 'home', title: 'Home', kind: 'page', visibility: 'private' })
    expect(String(home.body)).toContain('# Kindred Digital Labs')
    expect(String(home.body)).toContain('an AI-native company OS')
    expect(fx.toolCalls[1]!.input).toMatchObject({ slug: 'about', title: 'About' })
    expect(fx.toolCalls[2]!.input).toMatchObject({ slug: 'contact', title: 'Contact' })

    const brandDoc = fx.toolCalls[3]!.input
    expect(brandDoc).toMatchObject({
      slug: 'brand-tone-of-voice',
      title: 'Brand — Tone of Voice',
      kind: 'doc',
      visibility: 'private',
    })
    expect(String(brandDoc.body)).toContain('warm, direct, technical')
    expect(String(brandDoc.body)).toContain('Kindred Digital Labs')
  })

  it('gates publishes: approval_required records pending, surfaces the event, journey stays active', async () => {
    const fx = fixture()
    const surfaceEvents: Array<{ type: string; tool?: string; approvalId?: string }> = []
    const sinks = {
      stream: () => {},
      surfaceEvent: (event: { type: string; tool?: string }) => surfaceEvents.push(event),
    }
    await runFoundingJourney(fx, sinks)

    const pending = await fx.approvals.listPending()
    expect(pending).toHaveLength(1)
    expect(surfaceEvents).toContainEqual({
      type: 'approval.required',
      tool: 'website.publish_page',
      approvalId: pending[0]!.id,
    })
    expect(pending[0]).toMatchObject({ toolName: 'website.publish_page', status: 'pending' })
    expect(pending[0]!.input).toEqual({ slug: 'home', visibility: 'public' })

    const row = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(row?.status).toBe('active')
    // Spec order: the skeleton pages (positioning step), then the gated publish;
    // the brand doc (tone step, final) executes after them.
    expect(row?.state.artifacts.map((a) => [a.tool, a.status])).toEqual([
      ['website.create_page', 'executed'],
      ['website.create_page', 'executed'],
      ['website.create_page', 'executed'],
      ['website.publish_page', 'approval_pending'],
      ['website.create_page', 'executed'],
    ])
  })

  it('after owner approval, pending publishes retry and the journey completes with a kernel event', async () => {
    const fx = fixture()
    await runFoundingJourney(fx)

    const pending = await fx.approvals.listPending()
    await fx.approvals.decide(pending[0]!.id, 'approved', 'owner')

    fx.script.push('Published!')
    const reply = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'nice')

    expect(reply).toBe('Published!')
    const publishes = fx.toolCalls.filter((c) => c.tool === 'website.publish_page')
    expect(publishes.map((c) => c.input.slug)).toEqual(['home', 'about', 'contact'])
    for (const slug of ['home', 'about', 'contact']) {
      expect(fx.pages.get(slug)?.visibility).toBe('public')
    }

    // Completed: no active journey, completion event is metadata-only.
    expect(await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)).toBeNull()
    const completed = fx.sink.events.filter((e) => e.type === 'journey.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]!.payload).toMatchObject({ kind: 'website_founding' })
    expect(String(completed[0]!.payload)).not.toContain('warm, direct')
    expect(completed[0]!.principalId).toBe('orchestrator')
  })

  it('surfaces the approval gate as text on sink-less surfaces (Telegram path)', async () => {
    const fx = fixture()
    const replies = await runFoundingJourney(fx)

    expect(await fx.approvals.listPending()).toHaveLength(1)
    // Without a surfaceEvent sink the driver says the gate in text, marker-free.
    expect(replies[2]).toContain('owner approval')
    expect(replies[2]).not.toContain('[[journey:')
  })

  it('hands artifact errors back to the agent for one more step — never thrown to the caller', async () => {
    const fx = fixture({ failOnSlug: 'brand-tone-of-voice' })
    await fx.journeys.create(
      WEBSITE_FOUNDING_JOURNEY.kind,
      initialJourneyState('session-1', WEBSITE_FOUNDING_JOURNEY.specVersion),
    )

    fx.script.push(`Great.\n${marker('company_name')}`)
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'Kindred Digital Labs')

    fx.script.push(`Noted.\n${marker('positioning')}`)
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'an AI-native company OS')

    // The brand doc is the tone step's artifact (the final step): the failure
    // surfaces on the turn that captures tone — as an observation the model sees.
    fx.script.push(`All done, your brand doc is live!\n${marker('tone')}`)
    fx.script.push('I could not save your brand page just now — I will retry on your next message.')
    const before = fx.engineInputs.length
    const reply = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'warm, direct, technical')

    expect(reply.startsWith('I could not save your brand page just now — I will retry on your next message.')).toBe(true)
    expect(reply).not.toContain('All done')
    expect(fx.engineInputs).toHaveLength(before + 2)
    const observation = fx.engineInputs.at(-1)!
    expect(observation).toContain(HARNESS_OBSERVATION_HEADER)
    expect(observation).toContain('"code":"tool_failed"')
    expect(observation).toContain('duplicate website slug')
    // The ledger keeps the failed artifact pending: it retries next turn.
    const row = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(row?.state.captured).toContain('tone')
  })

  it('unknown_tool during a journey step reaches the model (missing tool on the kernel)', async () => {
    const fx = fixture()
    // A kernel without the website tools at all: the probe's registry call fails.
    const bare = new KernelRegistry({ eventSink: fx.sink, vcsCommitter: null })
    const runtime = new JourneyAwareAgentRuntime({
      registry: bare,
      isToolActive: async () => true,
      eventSink: fx.sink,
      rolesFor: () => ['admin', 'agent'],
      journeys: fx.journeys,
      spec: WEBSITE_FOUNDING_JOURNEY,
    })
    const inputs: string[] = []
    const replies = [`Thanks.\n${marker('company_name')}`, `Noted.\n${marker('positioning')}`, 'The website tools are not available yet; I will set that up.']
    runtime.registerEngine('durable', {
      run: async (_s, input) => {
        inputs.push(input)
        return replies.shift()!
      },
    })
    runtime.registerAgent(orchestratorAgentConfig())
    await fx.journeys.create(
      WEBSITE_FOUNDING_JOURNEY.kind,
      initialJourneyState('session-1', WEBSITE_FOUNDING_JOURNEY.specVersion),
    )

    await runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'Acme')
    const reply = await runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'We build things.')

    expect(reply).toBe('The website tools are not available yet; I will set that up.')
    expect(inputs.at(-1)).toContain(HARNESS_OBSERVATION_HEADER)
    expect(inputs.at(-1)).toContain('"code":"unknown_tool"')
  })

  it('module_inactive without the admin tools (the production incident) reaches the model', async () => {
    const sink = new InMemoryEventSink()
    const activations = new InMemoryActivationStore()
    const registry = new KernelRegistry({ eventSink: sink, activationStore: activations, vcsCommitter: null })
    registry.register({
      name: 'website.list_pages',
      module: 'website',
      summary: 'list',
      auditClass: 'read',
      inputSchema: z.looseObject({}),
      permission: { roles: ['admin'] },
      handler: async () => [],
    })
    const journeys = new InMemoryJourneyStore()
    const runtime = new JourneyAwareAgentRuntime({
      registry,
      isToolActive: async () => true,
      eventSink: sink,
      rolesFor: () => ['admin', 'agent'],
      journeys,
      spec: WEBSITE_FOUNDING_JOURNEY,
    })
    const inputs: string[] = []
    const replies = [`Thanks.\n${marker('company_name')}`, `Noted.\n${marker('positioning')}`, 'Your website module is still switching on — give me a moment.']
    runtime.registerEngine('durable', {
      run: async (_s, input) => {
        inputs.push(input)
        return replies.shift()!
      },
    })
    runtime.registerAgent(orchestratorAgentConfig())
    await journeys.create(WEBSITE_FOUNDING_JOURNEY.kind, initialJourneyState('s1', WEBSITE_FOUNDING_JOURNEY.specVersion))

    await runtime.dispatch(ORCHESTRATOR_AGENT_ID, 's1', 'Acme')
    const reply = await runtime.dispatch(ORCHESTRATOR_AGENT_ID, 's1', 'We build things.')

    expect(reply).toBe('Your website module is still switching on — give me a moment.')
    // The remediation itself fails (kernel.module_activate unknown): the agent sees it.
    expect(inputs.at(-1)).toContain('"code":"unknown_tool"')
    expect(inputs.at(-1)).toContain('kernel.module_activate')
  })

  it('a failing journey store read is handed to the agent, not thrown', async () => {
    const fx = fixture()
    fx.journeys.getActive = async () => {
      throw new Error('connection reset')
    }
    fx.script.push('I could not load where we left off — let us continue anyway.')
    const reply = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'hi')
    expect(reply).toBe('I could not load where we left off — let us continue anyway.')
    expect(fx.engineInputs[0]).toContain(HARNESS_OBSERVATION_HEADER)
    expect(fx.engineInputs[0]).toContain('journey.load')
    expect(fx.engineInputs[0]).toContain('hi')
  })

  it('a harness (engine) failure still rejects — the chat entry owns that case', async () => {
    const fx = fixture()
    // Script empty: the fake engine throws like an LLM outage.
    await expect(fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'hi')).rejects.toThrow(/script exhausted/)
  })

  it('records already-applied artifacts as executed instead of re-running them (duplicate-slug incident)', async () => {
    const fx = fixture()
    // The production incident: pages exist outside the ledger (legacy row /
    // an agent tool call created them). Retried creates must probe first and
    // record the ledger entry — never throw duplicate slug on later turns.
    for (const slug of ['home', 'about', 'contact', 'brand-tone-of-voice']) {
      fx.pages.set(slug, { slug, visibility: 'private' })
    }
    await runFoundingJourney(fx)

    expect(fx.toolCalls.filter((c) => c.tool === 'website.create_page')).toEqual([])
    const row = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(
      row?.state.artifacts
        .filter((a) => a.tool === 'website.create_page')
        .every((a) => a.status === 'executed'),
    ).toBe(true)
    // Publishes still flow through the normal gate.
    expect(await fx.approvals.listPending()).toHaveLength(1)

    // The user's exact scenario: a plain "hi" while the journey is active
    // must never surface a duplicate-slug error — retries are idempotent.
    fx.script.push('Still here.')
    const reply = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'hi')
    // Sink-less surface: the pending publish is still announced in text —
    // but the turn itself succeeds, no duplicate-slug throw.
    expect(reply).toContain('Still here.')
    expect(reply).toContain('owner approval')
    expect(fx.toolCalls.filter((c) => c.tool === 'website.create_page')).toEqual([])
  })

  it('skips a publish whose page already sits at the target visibility', async () => {
    const fx = fixture()
    fx.pages.set('home', { slug: 'home', visibility: 'public' })
    await runFoundingJourney(fx)

    // home's publish is already applied (recorded executed, no gate raised);
    // about/contact still publish → the first of them gates.
    const pending = await fx.approvals.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.input).toEqual({ slug: 'about', visibility: 'public' })
    const row = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(row?.state.artifacts.some((a) => a.status === 'approval_pending')).toBe(true)
  })

  it('is pure passthrough for non-orchestrator agents', async () => {
    const fx = fixture()
    fx.runtime.registerAgent({
      id: 'other-agent',
      personaName: 'Other',
      description: 'probe',
      loopEngine: 'durable',
      toolScope: 'all',
      memoryScope: 'company',
      verificationPolicy: 'none',
      enabled: true,
    })
    fx.script.push('plain answer')
    const reply = await fx.runtime.dispatch('other-agent', 'session-1', 'hi')
    expect(reply).toBe('plain answer')
    expect(fx.engineInputs[0]).toBe('hi')
    expect(await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)).toBeNull()
  })

  it('keeps the kernel approval semantics intact (double-gate does not duplicate requests)', async () => {
    const fx = fixture()
    await runFoundingJourney(fx)
    const pendingAfterInterview = (await fx.approvals.listPending()).length

    fx.script.push(`Still gated.\n${marker('positioning')}`)
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'status?')

    expect(pendingAfterInterview).toBe(1)
    expect(await fx.approvals.listPending()).toHaveLength(1)
  })

  it('never leaks KernelError-style gate errors as artifact failures (regression pin)', async () => {
    // The gate path is expected control flow: only non-approval errors throw.
    const fx = fixture()
    await runFoundingJourney(fx)
    const row = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    const gated = row!.state.artifacts.find((a) => a.tool === 'website.publish_page')
    expect(gated?.status).toBe('approval_pending')
    // Sanity: a real KernelError with the gate code exists and is matched by code.
    expect(new KernelError('approval_required', 'x').code).toBe('approval_required')
  })
})

describe('journey artifacts on a fresh server (module not yet active)', () => {
  it('the orchestrator activates the inactive module itself (audited kernel tool) and continues', async () => {
    const sink = new InMemoryEventSink()
    const activations = new InMemoryActivationStore()
    const modules = new ModuleRegistry(activations)
    const registry = new KernelRegistry({ eventSink: sink, activationStore: activations, vcsCommitter: null })
    modules.register(kernelManifest)
    modules.register({
      id: 'website',
      name: 'Website',
      version: '0.1.0',
      tools: ['website.list_pages', 'website.create_page', 'website.publish_page'],
      permissions: { roles: ['admin'] },
    })
    await activations.set('kernel', true)
    const adminApprovals = Object.assign(new InMemoryApprovalStore(), { list: async () => [] })
    for (const t of createAdminTools({ modules, activations, approvals: adminApprovals })) registry.register(t)
    const pages = new Map<string, { slug: string; visibility: string }>()
    const tool = (name: string, handler: ToolDescriptor['handler']): ToolDescriptor => ({
      name,
      module: 'website',
      summary: name,
      auditClass: name === 'website.list_pages' ? 'read' : 'mutate',
      activity: () => 'Did a test action',
      inputSchema: z.looseObject({}),
      permission: { roles: ['admin'] },
      handler,
    })
    registry.register(tool('website.list_pages', async () => [...pages.values()]))
    registry.register(
      tool('website.create_page', async (_c, input) => {
        const { slug } = input as { slug: string }
        pages.set(slug, { slug, visibility: 'private' })
        return { slug }
      }),
    )
    registry.register(
      tool('website.publish_page', async (_c, input) => {
        const { slug, visibility } = input as { slug: string; visibility: string }
        pages.set(slug, { slug, visibility })
        return { slug }
      }),
    )

    const state = initialJourneyState('s1', WEBSITE_FOUNDING_JOURNEY.specVersion)
    state.captured.push('company_name', 'positioning')
    state.answers = { company_name: 'Acme', positioning: 'We build things.' }

    const result = await executeStepArtifacts({ registry, spec: WEBSITE_FOUNDING_JOURNEY, state })

    expect(await activations.get('website')).toBe(true)
    expect([...pages.keys()].sort()).toEqual(['about', 'contact', 'home'])
    expect(result.allExecuted).toBe(false) // tone step not captured yet
    const activationAudit = sink.events.filter(
      (e) => e.type === 'tool.executed' && (e.payload as { tool: string }).tool === 'kernel.module_activate',
    )
    expect(activationAudit).toHaveLength(1)
  })
})
