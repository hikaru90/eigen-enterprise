import { describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryActivationStore } from '$lib/kernel/modules'

const { kernelHolder, isUserAdminMock, eventRows, journeyRows } = vi.hoisted(() => ({
  kernelHolder: { kernel: null as unknown },
  isUserAdminMock: vi.fn(async () => true),
  eventRows: [] as Array<{ ts: Date; payload: unknown }>,
  journeyRows: [] as Array<{ status: string }>,
}))

vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: isUserAdminMock }))
vi.mock('../../../../modules/index', () => ({ bootstrapKernel: () => kernelHolder.kernel }))
vi.mock('../../../../modules/orchestrator/brain', () => ({
  WEBSITE_FOUNDING_JOURNEY: { kind: 'website-founding' },
}))
vi.mock('$lib/server/db', () => {
  // Chainable query fake: the first .from() decides which rows resolve.
  const query = (rows: () => unknown[]) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy']) chain[m] = () => chain
    chain.limit = async () => rows()
    return chain
  }
  return {
    getDb: () => ({
      select: () => ({
        from: (table: { [k: symbol]: unknown }) => {
          const name = String(Object.getOwnPropertySymbols(table).map((s) => table[s]).find((v) => typeof v === 'string'))
          return query(() => (name === 'kernel_events' ? eventRows : journeyRows))
        },
      }),
    }),
  }
})

import { load } from './+page.server'

async function kernel(active: string[]) {
  const activations = new InMemoryActivationStore()
  for (const id of active) await activations.set(id, true)
  const approvals = new InMemoryApprovalStore()
  await approvals.create({ id: 'ap1', toolName: 'website.publish_page', input: {}, principalId: 'agent', status: 'pending' })
  const tools: Record<string, { summary: string; output: unknown }> = {
    'website.site_info': {
      summary: 'Site info.',
      output: { url: 'http://localhost/site', pages: [{ slug: 'home', title: 'Home', status: 'draft', url: 'http://localhost/site/home' }] },
    },
    'website.publish_page': { summary: 'Publish a page.', output: null },
    'owlery.status': {
      summary: 'Email status.',
      output: { configured: true, region: 'eu-central-1', sender: 'hi@k.test', senderVerified: true, sandbox: false },
    },
  }
  const manifest = (id: string, name: string) => ({ id, name, version: '1', description: `${name} does work.`, tools: [], permissions: { roles: ['admin'] } })
  return {
    modules: { list: () => [manifest('website', 'Website'), manifest('email', 'Email'), manifest('brand', 'Brand')] },
    activations,
    approvals,
    registry: {
      get: (name: string) => (tools[name] ? { name, summary: tools[name].summary } : undefined),
      execute: vi.fn(async (name: string) => tools[name].output),
    },
  }
}

const event = (user: { id: string } | null) => ({ locals: { user } }) as unknown as Parameters<typeof load>[0]

describe('/overview load', () => {
  it('redirects signed-out visitors to login', async () => {
    await expect(load(event(null))).rejects.toMatchObject({ status: 302, location: '/login' })
  })

  it('shows active and inactive modules, website and email results, actions and approvals', async () => {
    kernelHolder.kernel = await kernel(['website', 'email'])
    journeyRows.splice(0, journeyRows.length, { status: 'active' })
    eventRows.splice(0, eventRows.length, {
      ts: new Date('2026-10-20T10:00:00.000Z'),
      payload: { tool: 'website.publish_page', auditClass: 'mutate', ok: true, activity: 'Published the Home page' },
    })
    const data = (await load(event({ id: 'owner' }))) as { overview: import('$lib/server/overview/overview').Overview }
    const { modules, actions, approvals } = data.overview
    expect(modules.map((m) => [m.id, m.active])).toEqual([
      ['website', true],
      ['email', true],
      ['brand', false],
    ])
    expect(modules[0].results).toContainEqual({ label: 'Home', detail: 'Draft', href: 'http://localhost/site/home' })
    expect(modules[0].results).toContainEqual({ label: 'Founding journey', detail: 'In progress', href: null })
    expect(modules[1].results).toEqual([{ label: 'hi@k.test', detail: 'Set up', href: null }])
    expect(JSON.stringify(data)).not.toMatch(/eu-central-1|secret|accessKey/i)
    expect(actions).toEqual([{ at: '2026-10-20T10:00:00.000Z', text: 'Published the Home page', ok: true }])
    expect(approvals).toEqual([{ id: 'ap1', text: 'Publish a page of your website' }])
  })
})
