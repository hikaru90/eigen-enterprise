import { describe, expect, it, vi } from 'vitest'

const { activationsGet } = vi.hoisted(() => ({
  activationsGet: vi.fn(async (_id: string) => true),
}))

vi.mock('$lib/server/boot', () => ({
  appKernel: async () => ({
    modules: {
      get: (id: string) =>
        id === 'memory' ? { id: 'memory', name: 'Memory', description: 'Notes and tasks.' } : null,
    },
    activations: { get: activationsGet },
  }),
}))

const privateEnv = vi.hoisted(() => ({ POSTHOG_API_KEY: '' as string | undefined }))
vi.mock('$lib/server/env/private-env', () => ({ env: privateEnv }))


const { load: layoutLoad } = await import('./+layout.server')
const { load } = await import('./+page.server')

const signedIn = { locals: { user: { id: 'u1' } } }

describe('/m/memory layout', () => {
  it('redirects signed-out visitors to login', async () => {
    await expect(layoutLoad({ locals: { user: null } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('reports the truthful activation state (Memory is a system module: active)', async () => {
    const data = (await layoutLoad(signedIn as never)) as { memory: { active: boolean } }
    expect(activationsGet).toHaveBeenCalledWith('memory')
    expect(data.memory).toEqual({ name: 'Memory', description: 'Notes and tasks.', active: true })
  })

  it('tells the privacy note whether AI requests also go to product analytics (POSTHOG_API_KEY)', async () => {
    privateEnv.POSTHOG_API_KEY = ''
    const off = (await layoutLoad(signedIn as never)) as { privacy: { analyticsSeesAi: boolean } }
    expect(off.privacy).toEqual({ analyticsSeesAi: false })
    privateEnv.POSTHOG_API_KEY = 'phc_test'
    const on = (await layoutLoad(signedIn as never)) as { privacy: { analyticsSeesAi: boolean } }
    expect(on.privacy).toEqual({ analyticsSeesAi: true })
  })
})

describe('/m/memory (no Overview any more: it lands on Tasks)', () => {
  it('redirects to /m/memory/tasks, where the open tasks are (plan/concept-memory-one-door.md, decision 1)', () => {
    expect(() => load(signedIn as never)).toThrow(expect.objectContaining({ status: 307, location: '/m/memory/tasks' }))
  })

  it('has no form actions left (the Overview’s Delete is the Tasks drawer’s, memory.delete_task)', async () => {
    const page = await import('./+page.server')
    expect('actions' in page).toBe(false)
  })
})
