import { describe, expect, it } from 'vitest'
import type { Principal, PrincipalStore } from '$lib/kernel/principals'
import { principalFlagValue, resolveCliPrincipal, PRINCIPAL_ENV_VAR } from './principal'

function makePrincipalStore(existing: Principal[]): {
  store: PrincipalStore
  getByIdCalls: string[]
} {
  const getByIdCalls: string[] = []
  const store: PrincipalStore = {
    getById: async (id) => {
      getByIdCalls.push(id)
      return existing.find((p) => p.id === id) ?? null
    },
    getByApiKey: async () => null,
  }
  return { store, getByIdCalls }
}

const stored: Principal[] = [
  { id: 'principal-1', kind: 'human', roles: ['admin', 'owner'] },
  { id: 'principal-2', kind: 'agent', roles: ['agent'] },
]

describe('resolveCliPrincipal', () => {
  it('resolves the explicit --principal flag', async () => {
    const { store, getByIdCalls } = makePrincipalStore(stored)
    const principal = await resolveCliPrincipal({
      flagValue: 'principal-2',
      env: {},
      principals: store,
    })
    expect(principal).toMatchObject({ id: 'principal-2', roles: ['agent'] })
    expect(getByIdCalls).toEqual(['principal-2'])
  })

  it('falls back to the environment variable when no flag is given', async () => {
    const { store } = makePrincipalStore(stored)
    const principal = await resolveCliPrincipal({
      flagValue: undefined,
      env: { [PRINCIPAL_ENV_VAR]: 'principal-1' },
      principals: store,
    })
    expect(principal).toMatchObject({ id: 'principal-1' })
  })

  it('the flag wins over the environment', async () => {
    const { store, getByIdCalls } = makePrincipalStore(stored)
    await resolveCliPrincipal({
      flagValue: 'principal-2',
      env: { [PRINCIPAL_ENV_VAR]: 'principal-1' },
      principals: store,
    })
    expect(getByIdCalls).toEqual(['principal-2'])
  })

  it('fails loud naming both options when neither flag nor env is present', async () => {
    const { store } = makePrincipalStore(stored)
    await expect(
      resolveCliPrincipal({ flagValue: undefined, env: {}, principals: store }),
    ).rejects.toThrow(/--principal <id>.*EE_CLI_PRINCIPAL_ID/s)
  })

  it('treats an explicitly empty flag as an error, not a fallback trigger', async () => {
    const { store } = makePrincipalStore(stored)
    await expect(
      resolveCliPrincipal({
        flagValue: '',
        env: { [PRINCIPAL_ENV_VAR]: 'principal-1' },
        principals: store,
      }),
    ).rejects.toThrow(/non-empty/)
  })

  it('fails loud on unknown principal ids', async () => {
    const { store } = makePrincipalStore(stored)
    await expect(
      resolveCliPrincipal({ flagValue: 'ghost', env: {}, principals: store }),
    ).rejects.toThrow(/unknown principal: ghost/)
  })
})

describe('principalFlagValue', () => {
  it('extracts string values and ignores boolean flags', () => {
    expect(principalFlagValue({ principal: 'p1' })).toBe('p1')
    expect(principalFlagValue({ principal: true })).toBeUndefined()
    expect(principalFlagValue({})).toBeUndefined()
  })
})
