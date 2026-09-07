import { describe, expect, it } from 'vitest'
import { load } from './+page.server'

describe('chat page server load', () => {
  it('redirects unauthenticated users to login', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('returns without throwing when authenticated', async () => {
    const result = await load({
      locals: { user: { id: 'u1', email: 'a@b.c' } },
    } as never)

    expect(result).toEqual({})
  })
})
