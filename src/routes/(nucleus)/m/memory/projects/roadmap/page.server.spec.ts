import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryRoadmapStore } from '../../../../../../../modules/orchestrator/roadmap/store'

const state = vi.hoisted(() => ({ store: null as unknown, admin: true }))

vi.mock('../../../../../../../modules/orchestrator/roadmap/store', async (orig) => {
  const actual =
    await orig<typeof import('../../../../../../../modules/orchestrator/roadmap/store')>()
  return { ...actual, defaultRoadmapStore: () => state.store }
})
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: async () => state.admin }))

const { load, actions } = await import('./+page.server')

const user = { id: 'u1', email: 'a@b.c' }

function form(fields: Record<string, string>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return {
    locals: { user },
    request: new Request('http://x/m/memory/projects/roadmap', { method: 'POST', body: fd }),
  }
}

const loadEvent = (u: typeof user | null) => ({ locals: { user: u }, depends: vi.fn() }) as never

describe('/m/memory/projects/roadmap', () => {
  let store: InMemoryRoadmapStore
  beforeEach(() => {
    store = new InMemoryRoadmapStore()
    state.store = store
    state.admin = true
  })

  it('redirects anonymous users', async () => {
    await expect(load(loadEvent(null))).rejects.toMatchObject({ status: 302 })
  })

  it('lists the project tasks and tells the page whether the viewer may edit', async () => {
    await store.create({ title: 'One' })
    const data = (await load(loadEvent(user))) as { items: unknown[]; canEdit: boolean }
    expect(data.items).toHaveLength(1)
    expect(data.canEdit).toBe(true)
  })

  it('members read the board but may not edit it', async () => {
    state.admin = false
    await store.create({ title: 'One' })
    const data = (await load(loadEvent(user))) as { items: unknown[]; canEdit: boolean }
    expect(data.items).toHaveLength(1)
    expect(data.canEdit).toBe(false)
  })

  it('the owner adds an item (planned by default) and moves it to in progress', async () => {
    await actions.add(form({ title: 'Invoices', detail: 'Send them', kind: 'fix' }) as never)
    const [item] = await store.list()
    expect(item).toMatchObject({
      title: 'Invoices',
      detail: 'Send them',
      kind: 'fix',
      status: 'planned',
    })

    await actions.update(form({ id: item.id, status: 'in_progress' }) as never)
    expect((await store.list())[0].status).toBe('in_progress')

    await actions.update(form({ id: item.id, title: 'Invoices v2', kind: 'feature' }) as never)
    expect((await store.list())[0]).toMatchObject({ title: 'Invoices v2', kind: 'feature' })
  })

  it('rejects an empty title and unknown statuses', async () => {
    expect(await actions.add(form({ title: '  ' }) as never)).toMatchObject({ status: 400 })
    await store.create({ title: 'X' })
    const [item] = await store.list()
    expect(await actions.update(form({ id: item.id, status: 'done' }) as never)).toMatchObject({
      status: 400,
    })
  })

  it('members cannot edit', async () => {
    state.admin = false
    expect(await actions.add(form({ title: 'Nope' }) as never)).toMatchObject({ status: 403 })
    expect(await store.list()).toHaveLength(0)
  })
})
