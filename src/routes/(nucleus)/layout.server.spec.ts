import { describe, expect, it, vi } from 'vitest'
import { InMemoryActivationStore } from '$lib/kernel/modules'

const { kernelHolder, journeyRows } = vi.hoisted(() => ({
  kernelHolder: { kernel: null as unknown },
  journeyRows: [] as Array<{ status: string; state: unknown }>,
}))

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

  it('leaves the company unnamed until the founding journey names it', async () => {
    kernelHolder.kernel = await kernel([])
    journeyRows.splice(0, journeyRows.length)
    const data = (await load(event({ id: 'owner' }))) as { shell: import('$lib/shell/nav').ShellData }
    expect(data.shell.companyName).toBeNull()
  })

  it('tells every text box whether dictation can work, and what is missing when not', async () => {
    kernelHolder.kernel = await kernel([])
    const data = (await load(event({ id: 'member-1' }))) as { shell: import('$lib/shell/nav').ShellData }
    expect(readiness).toHaveBeenCalledWith('member-1')
    expect(data.shell.dictation).toEqual({ ready: false, missing: 'openrouter_key' })
  })
})
