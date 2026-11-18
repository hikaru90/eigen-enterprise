import { describe, expect, it, vi } from 'vitest'
import { connectRoutes, type ConnectHttpDeps } from './connect-http'

class Explained extends Error {}

const view = {
  id: 'd-1',
  name: 'acme.test',
  status: 'NOT_STARTED',
  sendable: false,
  isVerifying: true,
  errorMessage: 'eigenEnterprise Mail is adding this domain (a minute or two).',
  adopted: false,
  lastCheckedAt: new Date('2026-11-18T10:00:00Z'),
  records: [],
  // DomainView carries more (DKIM key, region, …); the answer leaves it out.
  publicKey: 'MIIB…',
  region: 'eu-north-1',
}

function deps(over: Partial<ConnectHttpDeps['platform']> = {}, role: 'owner' | 'member' = 'owner') {
  return {
    role: vi.fn(async () => role),
    platform: { addDomain: vi.fn(async () => view), recheckDomain: vi.fn(async () => view), ...over },
    explained: (err: unknown): err is Error => err instanceof Explained,
  } satisfies ConnectHttpDeps
}

function ev(body?: unknown) {
  const url = new URL('https://os.test/api/domains/connected')
  return {
    locals: { user: { id: 'u1', email: 'ada@acme.test' } } as App.Locals,
    url,
    request: new Request(url, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  }
}

describe('connected domains routes', () => {
  it('adds the domain and answers only what the records view needs', async () => {
    const d = deps()
    const res = await connectRoutes(d).add(ev({ name: 'acme.test' }))
    expect(d.platform.addDomain).toHaveBeenCalledWith('acme.test', 'u1')
    expect(await res.json()).toEqual({
      domain: {
        id: 'd-1',
        name: 'acme.test',
        status: 'NOT_STARTED',
        sendable: false,
        isVerifying: true,
        errorMessage: view.errorMessage,
        adopted: false,
        lastCheckedAt: '2026-11-18T10:00:00.000Z',
        records: [],
      },
    })
  })

  it('an explained refusal is a 400 in its words; an empty name never reaches the platform', async () => {
    const d = deps({ addDomain: vi.fn(async () => Promise.reject(new Explained('acme.test is already added.'))) })
    const res = await connectRoutes(d).add(ev({ name: 'acme.test' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'acme.test is already added.' })
    expect((await connectRoutes(d).add(ev({ name: ' ' }))).status).toBe(400)
    expect(d.platform.addDomain).toHaveBeenCalledOnce()
  })

  it('check re-reads the domain', async () => {
    const d = deps()
    expect((await connectRoutes(d).check(ev(), 'd-1')).status).toBe(200)
    expect(d.platform.recheckDomain).toHaveBeenCalledWith('d-1')
  })

  it('members may not add domains', async () => {
    const d = deps({}, 'member')
    expect((await connectRoutes(d).add(ev({ name: 'acme.test' }))).status).toBe(403)
    expect(d.platform.addDomain).not.toHaveBeenCalled()
  })
})
