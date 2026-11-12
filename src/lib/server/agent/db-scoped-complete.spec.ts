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
      onCompanyProvider: (fn) => fn(),
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
      onCompanyProvider: (fn) => fn(),
      chatCompletion: async () => {
        throw new Error('provider down')
      },
    })

    await expect(complete({ userId: 'u1', messages: [] } as never)).rejects.toThrow('provider down')
    expect(trail).toEqual(['leave:u1'])
  })

  it('runs every model call on the company AI provider, so a member’s turn works (prod 2026-11-12)', async () => {
    // A member has no provider settings of their own; the owner set up the company's.
    // Without this the member's chat died with "Platform EUrouter not configured".
    const trail: string[] = []
    let onCompany = false
    const complete = createDbScopedComplete({
      withDbUser: async (userId, fn) => {
        trail.push(`enter:${userId}:company=${onCompany}`)
        return fn()
      },
      onCompanyProvider: async (fn) => {
        onCompany = true
        try {
          return await fn()
        } finally {
          onCompany = false
        }
      },
      chatCompletion: async (input) => {
        trail.push(`call:${input.userId}:company=${onCompany}`)
        return { content: 'ok' } as never
      },
    })

    await complete({ userId: 'member-1', messages: [] } as never)

    // Usage stays attributed to the member; only the provider is the company's.
    expect(trail).toEqual(['enter:member-1:company=true', 'call:member-1:company=true'])
  })
})
