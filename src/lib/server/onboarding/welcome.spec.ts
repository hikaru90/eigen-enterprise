import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))

import { completeWelcomeOnboarding, resetWelcomeOnboarding } from './welcome'

describe('completeWelcomeOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function chainCapturing() {
    const captured: { values?: unknown; set?: unknown } = {}
    const chain = {
      insert() {
        return chain
      },
      values(values: unknown) {
        captured.values = values
        return chain
      },
      onConflictDoUpdate(config: { set: unknown }) {
        captured.set = config.set
        return Promise.resolve()
      },
    }
    return { chain, captured }
  }

  it('stamps welcome_completed_at for the user (upsert insert leg)', async () => {
    const { chain, captured } = chainCapturing()
    getDbMock.mockReturnValue(chain)

    await completeWelcomeOnboarding('u1')

    expect(captured.values).toMatchObject({ userId: 'u1', welcomeCompletedAt: expect.any(Date) })
  })

  it('re-stamps on conflict instead of failing on a second completion', async () => {
    const { chain, captured } = chainCapturing()
    getDbMock.mockReturnValue(chain)

    await completeWelcomeOnboarding('u1')
    await completeWelcomeOnboarding('u1')

    expect(captured.set).toMatchObject({ welcomeCompletedAt: expect.any(Date) })
  })

  it('fails loud when persistence breaks', async () => {
    getDbMock.mockReturnValue({
      insert() {
        throw new Error('db down')
      },
    })

    await expect(completeWelcomeOnboarding('u1')).rejects.toThrow('db down')
  })
})

describe('resetWelcomeOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears welcome_completed_at (upsert insert leg) so the wizard shows again', async () => {
    const captured: { values?: unknown; set?: unknown } = {}
    const chain = {
      insert() {
        return chain
      },
      values(values: unknown) {
        captured.values = values
        return chain
      },
      onConflictDoUpdate(config: { set: unknown }) {
        captured.set = config.set
        return Promise.resolve()
      },
    }
    getDbMock.mockReturnValue(chain)

    await resetWelcomeOnboarding('u1')

    expect(captured.values).toMatchObject({ userId: 'u1', welcomeCompletedAt: null })
    expect(captured.set).toMatchObject({ welcomeCompletedAt: null })
  })

  it('fails loud when persistence breaks', async () => {
    getDbMock.mockReturnValue({
      insert() {
        throw new Error('db down')
      },
    })

    await expect(resetWelcomeOnboarding('u1')).rejects.toThrow('db down')
  })
})
