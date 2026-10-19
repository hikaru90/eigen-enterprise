import { beforeEach, describe, expect, it, vi } from 'vitest'

let admin = true
let saveError: Error | null = null
const saved: unknown[] = []
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: async () => admin }))
vi.mock('$lib/server/mail', () => ({
  companyMail: () => ({
    saveVerified: async (input: unknown) => {
      if (saveError) throw saveError
      saved.push(input)
    },
  }),
}))

const { POST } = await import('./+server')

const req = (body: unknown, user: unknown = { id: 'u1', email: 'owner@kindred.test' }) =>
  ({ locals: { user }, request: new Request('http://x/api/onboarding/mail', { method: 'POST', body: JSON.stringify(body) }) }) as never

describe('POST /api/onboarding/mail', () => {
  beforeEach(() => {
    admin = true
    saveError = null
    saved.length = 0
  })

  it("saves via a test email to the owner's own address", async () => {
    const res = await POST(req({ baseUrl: 'https://owlery.example', apiKey: 'k', emailFrom: 'hi@kindred.test' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, testSentTo: 'owner@kindred.test' })
    expect(saved[0]).toMatchObject({ testRecipient: 'owner@kindred.test', updatedBy: 'u1', apiKey: 'k' })
  })

  it('is owner-only and requires a session', async () => {
    admin = false
    expect((await POST(req({}))).status).toBe(403)
    expect((await POST(req({}, null))).status).toBe(401)
  })

  it('reports why the test email failed, saving nothing', async () => {
    saveError = new Error('Owlery POST /api/v1/emails failed: 401 invalid key')
    const res = await POST(req({ baseUrl: 'https://owlery.example', apiKey: 'bad', emailFrom: 'hi@kindred.test' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid key/)
    expect(saved).toEqual([])
  })
})
