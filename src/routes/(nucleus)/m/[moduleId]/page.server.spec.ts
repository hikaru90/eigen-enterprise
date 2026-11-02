import { ownerModuleBlurb } from '$lib/shell/module-copy'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { AppUserError } from '../../../../../modules/website/apps/contract'

const { kernelHolder, isUserAdminMock } = vi.hoisted(() => ({
  kernelHolder: { kernel: null as unknown },
  isUserAdminMock: vi.fn(async () => true),
}))

vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: isUserAdminMock }))
vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
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
      id: 'brand',
      name: 'Brand',
      version: '1',
      description: 'The company look.',
      tools: [],
      permissions: { roles: ['admin'] },
    },
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
    {
      id: 'website',
      name: 'Website',
      version: '1',
      description: 'Apps, site, hosting.',
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
      execute: vi.fn(async (tool: string) => {
        if (tool === 'website.activity')
          return {
            managed: false,
            items: [
              {
                at: '2026-10-20T10:00:00Z',
                source: 'tool',
                kind: 'page',
                text: 'Published the About page',
                workload: null,
                href: null,
              },
            ],
          }
        return {
          configured: true,
          sender: 'hi@k.test',
          senderVerified: false,
        }
      }),
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
      description: ownerModuleBlurb('email', 'Company email.'),
      active: true,
      resultsTitle: 'Sender',
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

  it('404s for /m/brand: the Brand page is /brand (one entry per module)', async () => {
    kernelHolder.kernel = await kernel(['brand'])
    await expect(load(event('brand'))).rejects.toMatchObject({ status: 404 })
  })
})

describe('/m/[moduleId]: the Website module page also carries recent activity (W5)', () => {
  it('reads website.activity through the kernel as the owner and passes it to the panel', async () => {
    const k = await kernel(['website'])
    kernelHolder.kernel = k
    const data = (await load(event('website'))) as {
      module: { id: string }
      activity: { managed: boolean; items: Array<{ text: string }> } | null
      activityError: string | null
    }
    expect(data.module.id).toBe('website')
    expect(data.activity).toEqual({
      managed: false,
      items: [
        {
          at: '2026-10-20T10:00:00Z',
          source: 'tool',
          kind: 'page',
          text: 'Published the About page',
          workload: null,
          href: null,
        },
      ],
    })
    expect(data.activityError).toBeNull()
    const [tool, input] = k.registry.execute.mock.calls.find(([t]) => t === 'website.activity') as [
      string,
      unknown,
    ]
    expect(tool).toBe('website.activity')
    expect(input).toEqual({ limit: 10 })
  })

  it('a non-admin gets no activity read at all (the kernel would refuse; nothing is disguised)', async () => {
    isUserAdminMock.mockImplementation(async () => false)
    try {
      const k = await kernel(['website'])
      kernelHolder.kernel = k
      const data = (await load(event('website'))) as { activity: unknown; activityError: unknown }
      expect(data.activity).toBeNull()
      expect(data.activityError).toBeNull()
      expect(k.registry.execute.mock.calls.filter(([t]) => t === 'website.activity')).toEqual([])
    } finally {
      isUserAdminMock.mockImplementation(async () => true)
    }
  })

  it('a failing activity read keeps the page up and repeats its plain sentence', async () => {
    const k = await kernel(['website'])
    kernelHolder.kernel = k
    k.registry.execute.mockImplementation(async (tool: string) => {
      if (tool === 'website.activity')
        throw new AppUserError(
          "The server's deploy agent could not read the server status. Try again; if it keeps happening, ask in the chat.",
        )
      return { configured: true, sender: 'hi@k.test', senderVerified: false }
    })
    const data = (await load(event('website'))) as {
      activity: unknown
      activityError: string | null
    }
    expect(data.activity).toBeNull()
    expect(data.activityError).toBe(
      "The server's deploy agent could not read the server status. Try again; if it keeps happening, ask in the chat.",
    )
  })

  it('an unexpected activity failure becomes an explicit sentence, never a broken page', async () => {
    const k = await kernel(['website'])
    kernelHolder.kernel = k
    k.registry.execute.mockImplementation(async (tool: string) => {
      if (tool === 'website.activity') throw new Error('boom')
      return { configured: true, sender: 'hi@k.test', senderVerified: false }
    })
    const data = (await load(event('website'))) as { activityError: string | null }
    expect(data.activityError).toBe(
      'Activity could not be loaded. Try again; if it keeps happening, ask in the chat.',
    )
  })

  it('another module never triggers an activity read', async () => {
    const k = await kernel(['email'])
    kernelHolder.kernel = k
    const data = (await load(event('email'))) as { activity: unknown }
    expect(data.activity).toBeNull()
    expect(k.registry.execute.mock.calls.filter(([t]) => t === 'website.activity')).toEqual([])
  })

  it('an inactive website module shows no activity (the page shows "Not active")', async () => {
    const k = await kernel([])
    kernelHolder.kernel = k
    const data = (await load(event('website'))) as { activity: unknown }
    expect(data.activity).toBeNull()
    expect(k.registry.execute).not.toHaveBeenCalled()
  })
})
