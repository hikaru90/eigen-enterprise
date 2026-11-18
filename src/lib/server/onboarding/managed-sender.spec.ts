import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoughtDomain } from '$lib/domains/contract'
import { managedSenderRoute, type ManagedSenderDeps } from './managed-sender'

function ev(body: unknown, user = true) {
  const url = new URL('https://os.test/api/onboarding/sender')
  return {
    locals: (user ? { user: { id: 'u1', email: 'ada@acme.test' } } : {}) as App.Locals,
    url,
    request: new Request(url, { method: 'POST', body: JSON.stringify(body) }),
  }
}

describe('POST /api/onboarding/sender (managed Email act)', () => {
  let deps: ManagedSenderDeps & { setDefaultSender: ReturnType<typeof vi.fn> }
  let bought: BoughtDomain[]
  beforeEach(() => {
    bought = []
    deps = {
      role: vi.fn(async () => 'owner' as const),
      mode: vi.fn(async () => 'managed' as const),
      mailDomains: vi.fn(async () => [{ name: 'acme.test', sendable: true }]),
      bought: vi.fn(async () => bought),
      setDefaultSender: vi.fn(async () => {}),
    }
  })

  it('sets the default sender on a company mail domain', async () => {
    const res = await managedSenderRoute(deps)(ev({ address: ' Hello@Acme.test ' }))
    expect(await res.json()).toEqual({ ok: true, address: 'hello@acme.test', ready: true })
    expect(deps.setDefaultSender).toHaveBeenCalledWith('hello@acme.test', 'u1')
  })

  it('accepts a domain bought here that is still on its way (not ready yet)', async () => {
    bought = [{ name: 'acme.eu', state: 'registering', error: null, renewsAt: null, autoRenew: true }]
    const res = await managedSenderRoute(deps)(ev({ address: 'hello@acme.eu' }))
    expect(await res.json()).toEqual({ ok: true, address: 'hello@acme.eu', ready: false })
  })

  it('refuses a domain that is not the company’s, or a failed purchase', async () => {
    bought = [{ name: 'acme.eu', state: 'failed', error: 'Registry refused.', renewsAt: null, autoRenew: false }]
    for (const address of ['me@gmail.test', 'hello@acme.eu']) {
      const res = await managedSenderRoute(deps)(ev({ address }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/not one of the company’s domains/)
    }
    expect(deps.setDefaultSender).not.toHaveBeenCalled()
  })

  it('refuses outside managed mode, a bad address, and members', async () => {
    deps.mode = vi.fn(async () => 'own' as const)
    expect((await managedSenderRoute(deps)(ev({ address: 'hello@acme.test' }))).status).toBe(400)
    deps.mode = vi.fn(async () => 'managed' as const)
    expect((await managedSenderRoute(deps)(ev({ address: 'hello' }))).status).toBe(400)
    deps.role = vi.fn(async () => 'member' as const)
    expect((await managedSenderRoute(deps)(ev({ address: 'hello@acme.test' }))).status).toBe(403)
    expect((await managedSenderRoute(deps)(ev({ address: 'hello@acme.test' }, false))).status).toBe(401)
    expect(deps.setDefaultSender).not.toHaveBeenCalled()
  })
})
