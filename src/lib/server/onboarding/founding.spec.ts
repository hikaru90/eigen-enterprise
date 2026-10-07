import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryJourneyStore } from '$lib/kernel/playbook'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { ORCHESTRATOR_AGENT_ID, WEBSITE_FOUNDING_JOURNEY } from '../../../../modules/orchestrator/brain'
import { recordFoundingInterview } from './founding'

/**
 * The welcome wizard's founding interview, server-side: answers become the
 * website-founding journey (fully captured) and the journey artifacts run
 * through a REAL KernelRegistry — permissions, approval gate, audit apply for
 * real. Publishes gate exactly like the chat driver's artifacts
 * (approval_pending → retried on a later submission/chat turn).
 */

type FakePage = { slug: string; visibility: string; body?: string }

function fixture() {
  const sink = new InMemoryEventSink()
  const approvals = new InMemoryApprovalStore()
  const pages = new Map<string, FakePage>()
  const toolCalls: Array<{ tool: string; input: Record<string, unknown> }> = []

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
      if (pages.has(args.slug)) throw new Error(`duplicate website slug: ${args.slug}`)
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

  const journeys = new InMemoryJourneyStore()

  const submit = (answers: {
    tone?: string
    companyName?: string
    positioning?: string
  }) =>
    recordFoundingInterview({
      registry,
      journeys,
      eventSink: sink,
      sessionId: 'onboarding:u1',
      answers,
    })

  return { sink, approvals, pages, toolCalls, journeys, submit }
}

describe('recordFoundingInterview (onboarding founding endpoint logic)', () => {
  it('skips loudly-clean when every answer is blank (including whitespace-only)', async () => {
    const fx = fixture()

    await expect(fx.submit({})).resolves.toEqual({ skipped: true })
    await expect(fx.submit({ tone: '   ', companyName: '', positioning: '\n' })).resolves.toEqual({
      skipped: true,
    })
    expect(await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)).toBeNull()
    expect(fx.toolCalls).toEqual([])
  })

  it('records the interview as a fully-captured journey and executes the artifacts', async () => {
    const fx = fixture()
    const result = await fx.submit({
      tone: 'warm, direct, technical',
      companyName: 'Kindred Digital Labs',
      positioning: 'an AI-native company OS',
    })

    expect(result).toMatchObject({ skipped: false, executed: 4, approvalPending: 1 })

    const row = await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
    expect(row).not.toBeNull()
    expect(row!.state.captured).toEqual(['tone', 'company_name', 'positioning'])
    expect(row!.state.stepIndex).toBe(WEBSITE_FOUNDING_JOURNEY.steps.length)
    expect(row!.state.answers).toEqual({
      tone: 'warm, direct, technical',
      company_name: 'Kindred Digital Labs',
      positioning: 'an AI-native company OS',
    })
    expect(row!.state.sessionId).toBe('onboarding:u1')
    expect(row!.status).toBe('active')

    // Artifacts derive from the recorded answers (same spec derivations the
    // chat driver uses), and the publish batch stops at the first open gate.
    expect(fx.toolCalls.map((c) => c.tool)).toEqual([
      'website.create_page',
      'website.create_page',
      'website.create_page',
      'website.create_page',
    ])
    const brandDoc = fx.toolCalls[0]!.input
    expect(brandDoc).toMatchObject({ slug: 'brand-tone-of-voice', title: 'Brand — Tone of Voice' })
    expect(String(brandDoc.body)).toContain('warm, direct, technical')
    expect(String(brandDoc.body)).toContain('Kindred Digital Labs')
    expect(String(fx.toolCalls[1]!.input.body)).toContain('# Kindred Digital Labs')

    // Gated: journey stays active, no completion event yet.
    expect((await fx.approvals.listPending()).map((p) => p.toolName)).toEqual([
      'website.publish_page',
    ])
    expect(fx.sink.events.filter((e) => e.type === 'journey.completed')).toHaveLength(0)
  })

  it('re-submission overwrites the recorded answers and retries gated publishes after approval', async () => {
    const fx = fixture()
    await fx.submit({ tone: 'warm', companyName: 'Kindred', positioning: 'company OS' })

    // The owner approves the pending publish; the wizard gets resubmitted
    // (restart onboarding) with corrected answers.
    const pending = await fx.approvals.listPending()
    await fx.approvals.decide(pending[0]!.id, 'approved', 'owner')

    const result = await fx.submit({
      tone: 'precise, calm, expert',
      companyName: 'Kindred Digital Labs',
      positioning: 'the AI-native company OS',
    })

    // Publishes retried to completion; already-created pages were NOT
    // re-created (create_page fails loud on duplicates — deterministic).
    expect(result).toMatchObject({ skipped: false, executed: 7, approvalPending: 0, completed: true })
    expect(fx.toolCalls.filter((c) => c.tool === 'website.publish_page')).toHaveLength(3)
    for (const slug of ['home', 'about', 'contact']) {
      expect(fx.pages.get(slug)?.visibility).toBe('public')
    }

    const completed = fx.sink.events.filter((e) => e.type === 'journey.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]!.payload).toMatchObject({ kind: WEBSITE_FOUNDING_JOURNEY.kind })
    expect(completed[0]!.principalId).toBe(ORCHESTRATOR_AGENT_ID)
    expect(String(completed[0]!.payload)).not.toContain('precise')
    expect(await fx.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)).toBeNull()
  })

  it('fails loud when the founding artifacts already exist (completed journey, no active row)', async () => {
    const fx = fixture()
    await fx.submit({ tone: 'warm', companyName: 'Kindred', positioning: 'company OS' })
    const pending = await fx.approvals.listPending()
    await fx.approvals.decide(pending[0]!.id, 'approved', 'owner')
    await fx.submit({ tone: 'warm', companyName: 'Kindred', positioning: 'company OS' })

    // Journey completed; a fresh submission would re-create existing pages.
    await expect(
      fx.submit({ tone: 'new tone', companyName: 'New Name', positioning: 'new positioning' }),
    ).rejects.toThrow(/duplicate website slug/)
  })
})
