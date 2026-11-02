import { describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('$lib/server/auth/require-admin', () => ({
  requireAdmin: async (user: unknown) => user,
}))
vi.mock('$lib/server/boot', () => ({
  appKernel: async () => ({ registry: { execute } }),
}))

import { load } from './+page.server'

type LoadEvent = Parameters<typeof load>[0]
const run = (setId: string) =>
  load({ locals: { user: { id: 'owner-1' } }, params: { setId } } as unknown as LoadEvent)

describe('/brand/editor/[setId] load', () => {
  it('a malformed id is a plain 404, never the raw validator text', async () => {
    await expect(run('x')).rejects.toMatchObject({
      status: 404,
      body: { message: 'Visual set not found' },
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('an unknown set is a 404', async () => {
    execute.mockResolvedValueOnce(null)
    await expect(run('0b8f3c1e-8f5e-4c1a-9a3c-2f8d6a1b7c4d')).rejects.toMatchObject({ status: 404 })
  })
})
