import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = { dev: true, passes: 0 }

vi.mock('$app/environment', () => ({
  get dev() {
    return state.dev
  },
}))
vi.mock('../../../../../../modules/contribute/share/live', () => ({
  shareTick: async () => {
    state.passes += 1
    return { skipped: null, claimed: 1, sent: 1, unchanged: 0, withdrawn: 0, retried: 0, failed: 0 }
  },
}))

const { POST } = await import('./+server')

describe('/api/e2e/harness/contribute-share', () => {
  beforeEach(() => {
    state.dev = true
    state.passes = 0
  })

  it('is refused outside dev mode, exactly like the other harness routes', async () => {
    state.dev = false
    const res = await POST({} as never)
    expect(res.status).toBe(403)
    expect(state.passes).toBe(0)
  })

  it('runs one sharing pass now (what the job-queue tick does) and answers its result', async () => {
    const res = await POST({} as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: { skipped: null, claimed: 1, sent: 1, unchanged: 0, withdrawn: 0, retried: 0, failed: 0 } })
    expect(state.passes).toBe(1)
  })
})
