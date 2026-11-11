import { describe, expect, it, vi, beforeEach } from 'vitest'

const { findActive } = vi.hoisted(() => ({ findActive: vi.fn() }))
vi.mock('../../../../../modules/brand/store', () => ({
  defaultBrandStore: () => ({ findActiveVisualSet: findActive }),
}))

import { load } from './+page.server'

type LoadEvent = Parameters<typeof load>[0]
const run = (user: { id: string } | null) =>
  load({ locals: { user } } as unknown as LoadEvent) as Promise<{ style: unknown }>

describe('/brand/material load', () => {
  // Braces matter: a function returned from beforeEach is a cleanup hook.
  beforeEach(() => {
    findActive.mockReset()
  })

  it('redirects signed-out visitors to /login', async () => {
    await expect(run(null)).rejects.toMatchObject({ status: 302, location: '/login' })
    expect(findActive).not.toHaveBeenCalled()
  })

  it('a member sees the active set’s tokens (no admin gate)', async () => {
    findActive.mockResolvedValue({
      id: 's1',
      name: 'Blueprint',
      status: 'active',
      cssVars: { '--primary': '#ff0000' },
      darkCssVars: { '--primary': '#00ff00' },
      pins: {},
    })
    await expect(run({ id: 'member-1' })).resolves.toEqual({
      style: {
        id: 's1',
        name: 'Blueprint',
        cssVars: { '--primary': '#ff0000' },
        darkCssVars: { '--primary': '#00ff00' },
      },
    })
  })

  it('no active set → style null (the empty state)', async () => {
    findActive.mockResolvedValue(null)
    await expect(run({ id: 'member-1' })).resolves.toEqual({ style: null })
  })

  it('store failures propagate loud', async () => {
    findActive.mockRejectedValue(new Error('db down'))
    await expect(run({ id: 'member-1' })).rejects.toThrow('db down')
  })
})
