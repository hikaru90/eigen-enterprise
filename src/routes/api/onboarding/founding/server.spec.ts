import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryJourneyStore } from '$lib/kernel/playbook'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'

const { bootAppMock } = vi.hoisted(() => ({ bootAppMock: vi.fn() }))

vi.mock('$lib/server/boot', () => ({ bootApp: bootAppMock }))

import { POST as POST_FOUNDING } from './+server'

function fixture() {
  const sink = new InMemoryEventSink()
  const approvals = new InMemoryApprovalStore()
  const pages = new Map<string, { slug: string; visibility: string }>()

  const createPage: ToolDescriptor = {
    name: 'website.create_page',
    module: 'website',
    summary: 'fake create',
    auditClass: 'mutate',
    inputSchema: z.looseObject({ slug: z.string(), body: z.string().optional() }),
    permission: { roles: ['admin', 'agent'] },
    handler: async (_ctx: ToolContext, input: unknown) => {
      const args = input as { slug: string }
      if (pages.has(args.slug)) throw new Error(`duplicate website slug: ${args.slug}`)
      pages.set(args.slug, { slug: args.slug, visibility: 'private' })
      return { slug: args.slug }
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
      const page = pages.get(args.slug)
      if (!page) throw new Error(`unknown website page: ${args.slug}`)
      page.visibility = args.visibility
      return { slug: args.slug }
    },
  }
  const listPages: ToolDescriptor = {
    name: 'website.list_pages',
    module: 'website',
    summary: 'fake list',
    auditClass: 'read',
    inputSchema: z.looseObject({}),
    permission: { roles: ['admin', 'agent'] },
    handler: async () => [...pages.values()],
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

  const journeys = new InMemoryJourneyStore()
  bootAppMock.mockResolvedValue({
    kernel: { registry, eventSink: sink },
    journeys,
  })
  return { pages, journeys, approvals }
}

function event(body: unknown, signedIn = true) {
  return {
    locals: signedIn ? { user: { id: 'u1' } } : {},
    request: {
      json: async () => body,
    },
  } as never
}

describe('POST /api/onboarding/founding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires a signed-in user', async () => {
    const res = await POST_FOUNDING(event({ tone: 'warm' }, false))
    expect(res.status).toBe(401)
  })

  it('rejects invalid JSON and non-string answers (fail loud, no coercion)', async () => {
    const badJson = event(undefined)
    ;(badJson.request as { json: () => Promise<unknown> }).json = async () => {
      throw new Error('no json')
    }
    await expect(POST_FOUNDING(badJson)).rejects.toMatchObject({ status: 400 })
    await expect(POST_FOUNDING(event({ tone: 42 }))).rejects.toMatchObject({ status: 400 })
    await expect(POST_FOUNDING(event('not an object'))).rejects.toMatchObject({ status: 400 })
  })

  it('records the interview through the boot kernel and returns the result', async () => {
    const fx = fixture()
    const res = await POST_FOUNDING(
      event({ tone: 'warm, direct, technical', companyName: 'Kindred', positioning: 'company OS' }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { skipped: boolean; executed: number }
    expect(body).toMatchObject({ skipped: false, executed: 4 })
    expect(await fx.journeys.getActive('website_founding')).not.toBeNull()
  })

  it('blank answers skip without creating anything', async () => {
    const fx = fixture()
    const res = await POST_FOUNDING(event({}))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { skipped: boolean }).skipped).toBe(true)
    expect(await fx.journeys.getActive('website_founding')).toBeNull()
  })

  it('conflicts loudly when the company is already founded (no active journey, pages exist)', async () => {
    const fx = fixture()
    await POST_FOUNDING(event({ tone: 'warm' }))
    // Owner approves, a resubmission completes the journey (publishes retry).
    const pending = await fx.approvals.listPending()
    await fx.approvals.decide(pending[0]!.id, 'approved', 'owner')
    const second = await POST_FOUNDING(event({ tone: 'warm' }))
    expect(second.status).toBe(200)
    expect(((await second.json()) as { completed: boolean }).completed).toBe(true)

    // Journey completed; a fresh submission would re-create existing pages → 409.
    const res = await POST_FOUNDING(event({ tone: 'other' }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/already exists/i)
  })
})
