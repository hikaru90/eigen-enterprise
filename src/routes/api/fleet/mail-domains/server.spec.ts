import { describe, expect, it, vi } from 'vitest'
import { mailDomainsHandler } from '$lib/server/fleet/mail-domains'

const TOKEN = 'a'.repeat(43)
const req = (auth?: string) => new Request('http://127.0.0.1:4000/api/fleet/mail-domains', auth ? { headers: { authorization: auth } } : {})

describe('GET /api/fleet/mail-domains (ee reads the company mail domains, managed mode only)', () => {
  it('is 404 off a managed box and 401 with a wrong token', async () => {
    const list = vi.fn(async () => [])
    expect((await mailDomainsHandler({ token: undefined, list })(req(`Bearer ${TOKEN}`))).status).toBe(404)
    expect((await mailDomainsHandler({ token: TOKEN, list })(req(`Bearer ${'b'.repeat(43)}`))).status).toBe(401)
    expect(list).not.toHaveBeenCalled()
  })

  it('answers the domains with their receive flag', async () => {
    const res = await mailDomainsHandler({
      token: TOKEN,
      list: async () => [{ name: 'kindred.test', receive: true }, { name: 'news.kindred.test', receive: false }],
    })(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ domains: [{ name: 'kindred.test', receive: true }, { name: 'news.kindred.test', receive: false }] })
  })
})
