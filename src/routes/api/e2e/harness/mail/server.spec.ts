import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryFakeMailStore } from '../../../../../../modules/email/owlery/fake-store'

const state = { dev: true, transport: 'fake' as 'fake' | 'ses', settingsForgotten: 0 }
const fake = new InMemoryFakeMailStore()

vi.mock('$app/environment', () => ({
  get dev() {
    return state.dev
  },
}))
vi.mock('../../../../../../modules/email/owlery/fake-store', async (orig) => ({
  ...(await orig<typeof import('../../../../../../modules/email/owlery/fake-store')>()),
  defaultFakeMailStore: () => fake,
}))
vi.mock('../../../../../../modules/email/owlery/service', () => ({
  configuredMailTransport: () => state.transport,
  owleryService: () => ({
    forgetSettings: async () => {
      state.settingsForgotten += 1
    },
  }),
}))

const platformCalls: string[] = []
vi.mock('../../../../../../modules/email/platform/service', () => ({
  emailPlatform: () => ({
    applySesEvent: async () => {
      platformCalls.push('event')
      return { applied: true }
    },
    tick: async () => {
      platformCalls.push('tick')
      return { domains: 0, jobs: { done: 0, failed: 0 } }
    },
    store: {
      clearAll: async () => {
        platformCalls.push('clear')
      },
    },
    audience: {
      clearAll: async () => {
        platformCalls.push('clear-audience')
      },
    },
  }),
}))

const { GET, POST, DELETE } = await import('./+server')

const ev = (method: string, url: string, body?: unknown) =>
  ({
    url: new URL(url, 'http://x'),
    request: new Request(new URL(url, 'http://x'), { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
  }) as never

describe('/api/e2e/harness/mail', () => {
  beforeEach(async () => {
    state.dev = true
    state.transport = 'fake'
    state.settingsForgotten = 0
    await fake.clear()
  })

  it('is refused outside dev mode, exactly like the other harness routes', async () => {
    state.dev = false
    for (const res of [
      await GET(ev('GET', '/api/e2e/harness/mail')),
      await POST(ev('POST', '/api/e2e/harness/mail', { verify: 'a@b.co' })),
      await DELETE(ev('DELETE', '/api/e2e/harness/mail')),
    ]) {
      expect(res.status).toBe(403)
    }
  })

  it('is refused when the app does not run the fake transport', async () => {
    state.transport = 'ses'
    const res = await GET(ev('GET', '/api/e2e/harness/mail'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/MAIL_TRANSPORT=fake/) })
  })

  it('lists captured mails, optionally by recipient', async () => {
    await fake.capture({ from: 'f@x.co', to: 'a@x.co', subject: 'A', html: 'a', text: 'a' })
    await fake.capture({ from: 'f@x.co', to: 'b@x.co', subject: 'B', html: 'b', text: 'b' })
    const all = (await (await GET(ev('GET', '/api/e2e/harness/mail'))).json()) as { mails: { subject: string }[] }
    expect(all.mails.map((m) => m.subject)).toEqual(['A', 'B'])
    const one = (await (await GET(ev('GET', '/api/e2e/harness/mail?to=B@x.co'))).json()) as { mails: { subject: string }[] }
    expect(one.mails.map((m) => m.subject)).toEqual(['B'])
  })

  it('verifies an identity (what clicking Amazon’s link would do)', async () => {
    const res = await POST(ev('POST', '/api/e2e/harness/mail', { verify: 'hello@kindred.test' }))
    expect(res.status).toBe(200)
    expect(await fake.getIdentity('hello@kindred.test')).toEqual({ exists: true, verified: true })
    await expect(POST(ev('POST', '/api/e2e/harness/mail', {}))).rejects.toMatchObject({ status: 400 })
  })

  it('DELETE clears mails, identities and the company mail settings', async () => {
    await fake.capture({ from: 'f@x.co', to: 'a@x.co', subject: 'A', html: 'a', text: 'a' })
    await fake.verifyIdentity('f@x.co')
    const res = await DELETE(ev('DELETE', '/api/e2e/harness/mail'))
    expect(res.status).toBe(200)
    expect(await fake.list()).toEqual([])
    expect(await fake.getIdentity('f@x.co')).toEqual({ exists: false, verified: false })
    expect(state.settingsForgotten).toBe(1)
    expect(platformCalls).toContain('clear')
  })

  it('applies an SES event and runs the background pass on request', async () => {
    expect(await (await POST(ev('POST', '/api/e2e/harness/mail', { sesEvent: { eventType: 'Delivery' } }))).json()).toEqual({ applied: true })
    expect((await POST(ev('POST', '/api/e2e/harness/mail', { tick: true }))).status).toBe(200)
    expect(platformCalls).toEqual(expect.arrayContaining(['event', 'tick']))
  })
})
