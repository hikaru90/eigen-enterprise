import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MailSetupError, SenderNotVerifiedError } from '$lib/server/mail/company-mail'

let admin = true
let saveError: Error | null = null
const saved: unknown[] = []
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: async () => admin }))
vi.mock('$lib/server/mail', async () => {
  const actual = await import('$lib/server/mail/company-mail')
  return {
    ...actual,
    companyMail: () => ({
      saveVerified: async (input: unknown) => {
        if (saveError) throw saveError
        saved.push(input)
      },
    }),
  }
})

const { POST } = await import('./+server')

const body = { region: 'eu-central-1', accessKeyId: 'AKIA', secretAccessKey: 's3cret', emailFrom: 'hi@kindred.test' }
const req = (b: unknown, user: unknown = { id: 'u1', email: 'owner@kindred.test' }) =>
  ({ locals: { user }, request: new Request('http://x/api/onboarding/mail', { method: 'POST', body: JSON.stringify(b) }) }) as never

describe('POST /api/onboarding/mail', () => {
  beforeEach(() => {
    admin = true
    saveError = null
    saved.length = 0
  })

  it("saves via a test email to the owner's own address", async () => {
    const res = await POST(req(body))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, testSentTo: 'owner@kindred.test' })
    expect(saved[0]).toEqual({ ...body, testRecipient: 'owner@kindred.test', updatedBy: 'u1' })
  })

  it('is owner-only and requires a session', async () => {
    admin = false
    expect((await POST(req(body))).status).toBe(403)
    expect((await POST(req(body, null))).status).toBe(401)
    expect(saved).toEqual([])
  })

  it('409 verify_sender while Amazon waits for the sender to click its link', async () => {
    saveError = new SenderNotVerifiedError('hi@kindred.test')
    const res = await POST(req(body))
    expect(res.status).toBe(409)
    const out = await res.json()
    expect(out).toMatchObject({ needs: 'verify_sender', emailFrom: 'hi@kindred.test' })
    expect(out.error).toMatch(/hi@kindred\.test/)
  })

  it('400 with the plain-language reason for setup errors, saving nothing', async () => {
    saveError = new MailSetupError('Amazon does not recognise this access key ID.')
    const res = await POST(req(body))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Amazon does not recognise this access key ID.' })
    expect(saved).toEqual([])
  })

  it('400 without internals for unexpected errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    saveError = new Error('TENANT_MASTER_KEY is required')
    const res = await POST(req(body))
    expect(res.status).toBe(400)
    expect((await res.json()).error).not.toMatch(/TENANT_MASTER_KEY/)
    spy.mockRestore()
  })

  it('400 on a non-JSON body', async () => {
    const bad = { locals: { user: { id: 'u1', email: 'o@k.test' } }, request: new Request('http://x', { method: 'POST', body: '{' }) } as never
    expect((await POST(bad)).status).toBe(400)
  })
})
