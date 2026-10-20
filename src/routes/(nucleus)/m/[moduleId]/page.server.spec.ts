import { describe, expect, it, vi } from 'vitest'
import { InMemoryActivationStore } from '$lib/kernel/modules'

const { kernelHolder, isUserAdminMock } = vi.hoisted(() => ({
  kernelHolder: { kernel: null as unknown },
  isUserAdminMock: vi.fn(async () => true),
}))

vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: isUserAdminMock }))
vi.mock('../../../../../modules/index', () => ({ bootstrapKernel: () => kernelHolder.kernel }))
vi.mock('../../../../../modules/orchestrator/brain', () => ({
  WEBSITE_FOUNDING_JOURNEY: { kind: 'website-founding' },
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => {
        const chain: Record<string, unknown> = {}
        for (const m of ['where', 'orderBy']) chain[m] = () => chain
        chain.limit = async () => []
        return chain
      },
    }),
  }),
}))

import { load } from './+page.server'

async function kernel(active: string[]) {
  const activations = new InMemoryActivationStore()
  for (const id of active) await activations.set(id, true)
  const manifests = [
    {
      id: 'email',
      name: 'Email',
      version: '1',
      description: 'Company email.',
      tools: [],
      permissions: { roles: ['admin'] },
    },
    {
      id: 'repo',
      name: 'Repo',
      version: '1',
      description: 'Code repositories.',
      tools: [],
      permissions: { roles: ['admin'] },
    },
  ]
  return {
    modules: {
      list: () => manifests,
      get: (id: string) => manifests.find((m) => m.id === id),
    },
    activations,
    registry: {
      get: () => undefined,
      execute: vi.fn(async () => ({
        configured: true,
        sender: 'hi@k.test',
        senderVerified: false,
      })),
    },
  }
}

const event = (moduleId: string, user: { id: string } | null = { id: 'owner' }) =>
  ({ params: { moduleId }, locals: { user } }) as unknown as Parameters<typeof load>[0]

describe('/m/[moduleId] load', () => {
  it('redirects signed-out visitors to login', async () => {
    kernelHolder.kernel = await kernel([])
    await expect(load(event('email', null))).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('shows an active module with its results', async () => {
    kernelHolder.kernel = await kernel(['email'])
    const data = (await load(event('email'))) as {
      module: import('$lib/server/overview/overview').ModuleOverview
    }
    expect(data.module).toEqual({
      id: 'email',
      name: 'Email',
      description: 'Company email.',
      active: true,
      results: [{ label: 'hi@k.test', detail: 'Set up · sender not verified yet', href: null }],
      counts: [],
      note: null,
    })
  })

  it('shows an inactive module as not active, without reading results', async () => {
    const k = await kernel([])
    kernelHolder.kernel = k
    const data = (await load(event('repo'))) as {
      module: import('$lib/server/overview/overview').ModuleOverview
    }
    expect(data.module).toMatchObject({ id: 'repo', name: 'Repo', active: false, results: [] })
    expect(k.registry.execute).not.toHaveBeenCalled()
  })

  it('404s for an unknown module', async () => {
    kernelHolder.kernel = await kernel([])
    await expect(load(event('nope'))).rejects.toMatchObject({ status: 404 })
  })
})
