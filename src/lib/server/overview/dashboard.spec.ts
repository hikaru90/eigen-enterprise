import { describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryActivationStore } from '$lib/kernel/modules'

const { kernelHolder, roleMock, backupsMock, eventRows, journeyRows } = vi.hoisted(() => ({
  kernelHolder: { kernel: null as unknown },
  roleMock: vi.fn(async (): Promise<string> => 'admin'),
  backupsMock: vi.fn(),
  eventRows: [] as Array<{ ts: Date; payload: unknown }>,
  journeyRows: [] as Array<{ status: string }>,
}))

vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: roleMock,
  isAdminRole: (r: string | null) => r === 'owner' || r === 'admin',
}))
vi.mock('$lib/server/ee/client', () => {
  class SubstrateUnavailableError extends Error {}
  return {
    SubstrateUnavailableError,
    EeClient: class {
      backups = backupsMock
    },
  }
})
vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
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
          const name = String(
            Object.getOwnPropertySymbols(table)
              .map((s) => table[s])
              .find((v) => typeof v === 'string'),
          )
          return query(() => (name === 'kernel_events' ? eventRows : journeyRows))
        },
      }),
    }),
  }
})

import { loadDashboard } from './dashboard'

async function kernel(active: string[]) {
  const activations = new InMemoryActivationStore()
  for (const id of active) await activations.set(id, true)
  const approvals = new InMemoryApprovalStore()
  await approvals.create({
    id: 'ap1',
    toolName: 'website.publish_page',
    input: {},
    principalId: 'agent',
    status: 'pending',
  })
  const tools: Record<string, { summary: string; output: unknown }> = {
    'website.app_list': {
      summary: 'Apps overview.',
      output: {
        managed: true,
        services: [{ name: 'shop', status: 'healthy' }],
      },
    },
    'website.publish_page': { summary: 'Publish a page.', output: null },
    'owlery.status': {
      summary: 'Email status.',
      output: {
        configured: true,
        region: 'eu-central-1',
        sender: 'hi@k.test',
        senderVerified: true,
        sandbox: false,
      },
    },
  }
  const manifest = (id: string, name: string) => ({
    id,
    name,
    version: '1',
    description: `${name} does work.`,
    tools: [],
    permissions: { roles: ['admin'] },
  })
  return {
    modules: {
      list: () => [
        manifest('website', 'Website'),
        manifest('email', 'Email'),
        manifest('brand', 'Brand'),
      ],
    },
    activations,
    approvals,
    registry: {
      get: (name: string) => (tools[name] ? { name, summary: tools[name].summary } : undefined),
      execute: vi.fn(async (name: string) => tools[name].output),
    },
  }
}

describe('the dashboard at / (loadDashboard)', () => {
  it('shows active and inactive modules, website and email results, actions and approvals', async () => {
    kernelHolder.kernel = await kernel(['website', 'email'])
    journeyRows.splice(0, journeyRows.length, { status: 'active' })
    eventRows.splice(0, eventRows.length, {
      ts: new Date('2026-10-20T10:00:00.000Z'),
      payload: {
        tool: 'website.publish_page',
        auditClass: 'mutate',
        ok: true,
        activity: 'Published the Home page',
      },
    })
    const data = await loadDashboard('owner')
    const { modules, actions, approvals } = data.overview
    expect(modules.map((m) => [m.id, m.active])).toEqual([
      ['website', true],
      ['email', true],
      ['brand', false],
    ])
    expect(modules[0].results).toContainEqual({
      label: 'shop',
      detail: 'Healthy',
      href: '/m/website/apps/shop',
    })
    expect(modules[0].results).toContainEqual({
      label: 'Website setup (in chat)',
      detail: 'In progress',
      href: null,
    })
    expect(modules[1].results).toEqual([{ label: 'hi@k.test', detail: 'Set up', href: '/m/email' }])
    expect(JSON.stringify(data)).not.toMatch(/eu-central-1|secret|accessKey/i)
    expect(actions).toEqual([
      { at: '2026-10-20T10:00:00.000Z', text: 'Published the Home page', ok: true },
    ])
    expect(approvals).toEqual([{ id: 'ap1', text: 'Publish a page of your website' }])
    expect(data.backup).toBeNull()
    expect(backupsMock).not.toHaveBeenCalled()
  })

  it('the owner sees a failed nightly backup under Needs you; off an ee box there is nothing to show', async () => {
    kernelHolder.kernel = await kernel(['website'])
    roleMock.mockResolvedValue('owner')
    backupsMock.mockResolvedValueOnce({ health: { state: 'failed', at: 't', error: 'S3 PUT failed: 403 AccessDenied' }, runs: [] })
    const data = await loadDashboard('owner')
    expect(data.backup).toEqual({ kind: 'failed', text: 'The last backup failed: S3 PUT failed: 403 AccessDenied', href: '/settings/backups' })
    const { SubstrateUnavailableError } = await import('$lib/server/ee/client')
    backupsMock.mockRejectedValueOnce(new SubstrateUnavailableError('ENOENT'))
    expect((await loadDashboard('owner')).backup).toBeNull()
    roleMock.mockResolvedValue('admin')
  })
})
