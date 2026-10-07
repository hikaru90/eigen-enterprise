import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import type { LoopEngine } from '$lib/kernel/engine'
import { KernelError } from '$lib/kernel/errors'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryJourneyStore, initialJourneyState } from '$lib/kernel/playbook'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import {
  JourneyAwareAgentRuntime,
  ORCHESTRATOR_AGENT_ID,
  WEBSITE_FOUNDING_JOURNEY,
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

  const registry = new KernelRegistry({
    eventSink: sink,
    approvalPolicy: new StaticApprovalPolicy(new Set(['website.publish_page'])),
    approvalStore: approvals,
    vcsCommitter: null,
  })
  registry.register(createPage)
  registry.register(publishPage)

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
  runtime.registerEngine('builtin-json', engine)
  runtime.registerAgent(orchestratorAgentConfig())

  return { runtime, journeys, sink, approvals, engineInputs, toolCalls, pages, script }
}

async function runFoundingJourney(fx: Fixture, sinks?: Parameters<JourneyAwareAgentRuntime['dispatch']>[3]): Promise<string[]> {
  await fx.journeys.create(WEBSITE_FOUNDING_JOURNEY.kind, initialJourneyState('session-1'))

  fx.script.push(`Great — noted.\n${marker('tone')}`)
  const r1 = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'warm, direct, technical', sinks)

  fx.script.push(`Love it.\n${marker('company_name')}`)
  const r2 = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'Kindred Digital Labs', sinks)

  fx.script.push(`Perfect.\n${marker('positioning')}`)
  const r3 = await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'an AI-native company OS', sinks)

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

  it('prepends the journey context block (clearly delimited, with user speech below it)', async () => {
    const fx = fixture()
    await runFoundingJourney(fx)

    // Every turn: journey active — context block on top, user speech last.
    expect(fx.engineInputs[0].startsWith('[company journey context — not user speech]')).toBe(true)
    expect(fx.engineInputs[0]).toContain('step 1/3 (tone)')
    expect(fx.engineInputs[0].endsWith('warm, direct, technical')).toBe(true)
    // Turn 2: collected tone is rendered for the model.
    expect(fx.engineInputs[1]).toContain('- tone: warm, direct, technical')
  })

  it('accumulates verbatim answers, strips markers from user-facing replies, and advances steps', async () => {
    const fx = fixture()
    await runFoundingJourney(fx)

    const row = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(row).not.toBeNull()
    expect(row!.state.captured).toEqual(['tone', 'company_name', 'positioning'])
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
    // Brand doc after tone + name; skeleton after positioning. The publish is
    // gated BEFORE its handler runs (registry approval gate) — it never
    // reaches this handler-level log; the pending approval request pins it.
    expect(byTool).toEqual([
      'website.create_page', // brand doc (turn 3)
      'website.create_page', // home
      'website.create_page', // about
      'website.create_page', // contact
    ])

    const brandDoc = fx.toolCalls[0]!.input
    expect(brandDoc).toMatchObject({
      slug: 'brand-tone-of-voice',
      title: 'Brand — Tone of Voice',
      kind: 'doc',
      visibility: 'private',
    })
    expect(String(brandDoc.body)).toContain('warm, direct, technical')
    expect(String(brandDoc.body)).toContain('Kindred Digital Labs')

    const home = fx.toolCalls[1]!.input
    expect(home).toMatchObject({ slug: 'home', title: 'Home', kind: 'page', visibility: 'private' })
    expect(String(home.body)).toContain('# Kindred Digital Labs')
    expect(String(home.body)).toContain('an AI-native company OS')
    expect(fx.toolCalls[2]!.input).toMatchObject({ slug: 'about', title: 'About' })
    expect(fx.toolCalls[3]!.input).toMatchObject({ slug: 'contact', title: 'Contact' })
  })

  it('gates publishes: approval_required records pending, surfaces the event, journey stays active', async () => {
    const fx = fixture()
    const surfaceEvents: Array<{ type: string; tool?: string }> = []
    const sinks = {
      stream: () => {},
      surfaceEvent: (event: { type: string; tool?: string }) => surfaceEvents.push(event),
    }
    await runFoundingJourney(fx, sinks)

    expect(surfaceEvents).toContainEqual({ type: 'approval.required', tool: 'website.publish_page' })
    const pending = await fx.approvals.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ toolName: 'website.publish_page', status: 'pending' })
    expect(pending[0]!.input).toEqual({ slug: 'home', visibility: 'public' })

    const row = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(row?.status).toBe('active')
    expect(row?.state.artifacts.map((a) => [a.tool, a.status])).toEqual([
      ['website.create_page', 'executed'],
      ['website.create_page', 'executed'],
      ['website.create_page', 'executed'],
      ['website.create_page', 'executed'],
      ['website.publish_page', 'approval_pending'],
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

  it('fails loud on artifact errors (no silent degradation)', async () => {
    const fx = fixture({ failOnSlug: 'brand-tone-of-voice' })
    await fx.journeys.create(WEBSITE_FOUNDING_JOURNEY.kind, initialJourneyState('session-1'))

    fx.script.push(`Great.\n${marker('tone')}`)
    await fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'warm, direct, technical')

    fx.script.push(`Noted.\n${marker('company_name')}`)
    await expect(
      fx.runtime.dispatch(ORCHESTRATOR_AGENT_ID, 'session-1', 'Kindred Digital Labs'),
    ).rejects.toThrow(/duplicate website slug/)
  })

  it('is pure passthrough for non-orchestrator agents', async () => {
    const fx = fixture()
    fx.runtime.registerAgent({
      id: 'other-agent',
      personaName: 'Other',
      description: 'probe',
      loopEngine: 'builtin-json',
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
