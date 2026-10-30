import { describe, expect, it } from 'vitest'
import { createDbScopedComplete } from './db-scoped-complete'

describe('createDbScopedComplete', () => {
  it('runs every model call inside the attributed user’s DB session, not the caller’s', async () => {
    const trail: string[] = []
    let insideUser: string | null = null
    const complete = createDbScopedComplete({
      withDbUser: async (userId, fn) => {
        trail.push(`enter:${userId}`)
        insideUser = userId
        try {
          return await fn()
        } finally {
          insideUser = null
          trail.push(`leave:${userId}`)
        }
      },
      chatCompletion: async (input) => {
        trail.push(`call:${input.userId}:inside=${insideUser}`)
        return { content: 'ok' } as never
      },
    })

    await complete({ userId: 'user-b', messages: [] } as never)

    expect(trail).toEqual(['enter:user-b', 'call:user-b:inside=user-b', 'leave:user-b'])
  })

  it('propagates gateway failures loud (no swallowed error, session still released)', async () => {
    const trail: string[] = []
    const complete = createDbScopedComplete({
      withDbUser: async (userId, fn) => {
        try {
          return await fn()
        } finally {
          trail.push(`leave:${userId}`)
        }
      },
      chatCompletion: async () => {
        throw new Error('provider down')
      },
    })

    await expect(complete({ userId: 'u1', messages: [] } as never)).rejects.toThrow('provider down')
    expect(trail).toEqual(['leave:u1'])
  })
})
