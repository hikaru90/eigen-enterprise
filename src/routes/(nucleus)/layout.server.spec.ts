import { describe, expect, it, vi } from 'vitest'
import { InMemoryActivationStore } from '$lib/kernel/modules'

const { kernelHolder, journeyRows, profile, roleMock } = vi.hoisted(() => ({
  kernelHolder: { kernel: null as unknown },
  journeyRows: [] as Array<{ status: string; state: unknown }>,
  profile: { row: null as null | { name: string | null; logo: { sha256: string; mime: 'image/png' } | null } },
  roleMock: vi.fn(async (_id: string): Promise<string | null> => 'owner'),
}))

vi.mock('$lib/server/company/store', () => ({
  companyProfileStore: () => ({ get: async () => (profile.row ? { ...profile.row, updatedBy: 'u', updatedAt: new Date() } : null) }),
}))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
vi.mock('../../../modules/index', () => ({ bootstrapKernel: () => kernelHolder.kernel }))
vi.mock('../../../modules/orchestrator/brain', () => ({
  WEBSITE_FOUNDING_JOURNEY: { kind: 'website-founding' },
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => {
        const chain: Record<string, unknown> = {}
        for (const m of ['where', 'orderBy']) chain[m] = () => chain
        chain.limit = async () => journeyRows
        return chain
      },
    }),
  }),
}))

const { readiness } = vi.hoisted(() => ({
  readiness: vi.fn(async (_userId: string) => ({ ready: false, missing: 'openrouter_key' }) as const),
}))
vi.mock('$lib/server/llm/speech-readiness', () => ({ speechToTextReadiness: readiness }))

import { load } from './+layout.server'

async function kernel(active: string[]) {
  const activations = new InMemoryActivationStore()
  for (const id of active) await activations.set(id, true)
  return {
    modules: {
      list: () => [
        { id: 'website', name: 'Website' },
        { id: 'owlery', name: 'Email' },
        { id: 'repo', name: 'Repo' },
      ],
    },
    activations,
  }
}

const event = (user: { id: string } | null) => ({ locals: { user } }) as unknown as Parameters<typeof load>[0]

describe('(nucleus) layout load', () => {
  it('carries no shell for signed-out visitors', async () => {
    kernelHolder.kernel = await kernel([])
    expect(await load(event(null))).toEqual({ shell: null })
  })

  it('builds the nav from the module registry and activation state', async () => {
    kernelHolder.kernel = await kernel(['website', 'owlery'])
    journeyRows.splice(0, journeyRows.length, { status: 'active', state: { answers: { company_name: ' Kindred ' } } })
    const data = (await load(event({ id: 'owner' }))) as { shell: import('$lib/shell/nav').ShellData }
    expect(data.shell.companyName).toBe('Kindred')
    expect(data.shell.nav.items.map((m) => [m.id, m.active])).toEqual([
      ['website', true],
      ['owlery', true],
      ['repo', false],
      ['settings', true],
    ])
  })

  it('opens the call feed and the presence beat only for plugins that are on (round 4 W7: no retry loop against the plugin gate)', async () => {
    kernelHolder.kernel = await kernel(['calls'])
    const on = (await load(event({ id: 'owner' }))) as { liveFeeds: { calls: boolean; presence: boolean } }
    expect(on.liveFeeds).toEqual({ calls: true, presence: false })
    kernelHolder.kernel = await kernel(['messages', 'calls'])
    const both = (await load(event({ id: 'owner' }))) as { liveFeeds: { calls: boolean; presence: boolean } }
    expect(both.liveFeeds).toEqual({ calls: true, presence: true })
  })

  it('names the company and shows its logo from Settings → Company once set there', async () => {
    kernelHolder.kernel = await kernel([])
    journeyRows.splice(0, journeyRows.length, { status: 'active', state: { answers: { company_name: 'Kindred' } } })
    profile.row = { name: 'Kindred Digital Labs', logo: { sha256: 'c'.repeat(64), mime: 'image/png' } }
    const data = (await load(event({ id: 'owner' }))) as { shell: import('$lib/shell/nav').ShellData }
    profile.row = null
    expect(data.shell.companyName).toBe('Kindred Digital Labs')
    expect(data.shell.companyLogo).toBe(`/api/company/logo/${'c'.repeat(64)}`)
  })

  it('hands the shell one capability set and leaves pages a member cannot open out of the nav', async () => {
    kernelHolder.kernel = await kernel(['website', 'owlery'])
    roleMock.mockResolvedValueOnce('member')
    const member = (await load(event({ id: 'member-1' }))) as { shell: import('$lib/shell/nav').ShellData }
    expect(roleMock).toHaveBeenCalledWith('member-1')
    expect(Object.values(member.shell.capabilities).some(Boolean)).toBe(false)
    expect(member.shell.nav.items.map((m) => m.id)).toEqual(['owlery', 'repo', 'settings'])
    const owner = (await load(event({ id: 'owner' }))) as { shell: import('$lib/shell/nav').ShellData }
    expect(owner.shell.capabilities['company.manage']).toBe(true)
    expect(owner.shell.nav.items.map((m) => m.id)).toContain('website')
  })

  it('leaves the company unnamed until the founding journey names it', async () => {
    kernelHolder.kernel = await kernel([])
    journeyRows.splice(0, journeyRows.length)
    const data = (await load(event({ id: 'owner' }))) as { shell: import('$lib/shell/nav').ShellData }
    expect(data.shell.companyName).toBeNull()
    expect(data.shell.companyLogo).toBeNull()
  })

  // The plugin gate (src/hooks.server.ts) marks a page of a switched-off plugin; this load renders it.
  it.each([false, true])(
    'renders a switched-off plugin page as one clear 404 page (canManage %s), never the page itself',
    async (canManage) => {
      kernelHolder.kernel = await kernel([])
      const pluginOff = { id: 'drive', name: 'Drive', canManage }
      const e = { locals: { user: { id: 'u1' }, pluginOff } } as unknown as Parameters<typeof load>[0]
      await expect(load(e)).rejects.toMatchObject({
        status: 404,
        body: { message: 'Drive is switched off', pluginOff },
      })
    },
  )

  it('tells every text box whether dictation can work, and what is missing when not', async () => {
    kernelHolder.kernel = await kernel([])
    const data = (await load(event({ id: 'member-1' }))) as { shell: import('$lib/shell/nav').ShellData }
    expect(readiness).toHaveBeenCalledWith('member-1')
    expect(data.shell.dictation).toEqual({ ready: false, missing: 'openrouter_key' })
  })
})
