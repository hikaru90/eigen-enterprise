import { describe, expect, it } from 'vitest'
import { csrfRefusal, isCsrfExempt, isForbiddenCrossSiteForm } from './csrf'

const url = (p: string) => new URL(`https://os.kindred.test${p}`)
const req = (method: string, type: string | null, origin: string | null) =>
  new Request('https://os.kindred.test/x', {
    method,
    headers: { ...(type ? { 'content-type': type } : {}), ...(origin ? { origin } : {}) },
    ...(method === 'GET' ? {} : { body: 'x' }),
  })

describe('isForbiddenCrossSiteForm (SvelteKit checkOrigin, with exemptions)', () => {
  it('refuses cross-site and origin-less form posts, like SvelteKit', () => {
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain;charset=UTF-8']) {
      expect(isForbiddenCrossSiteForm(req('POST', type, 'https://evil.test'), url('/login'))).toBe(true)
      expect(isForbiddenCrossSiteForm(req('DELETE', type, null), url('/settings'))).toBe(true)
    }
  })

  it('allows same-origin forms, JSON bodies and safe methods', () => {
    expect(isForbiddenCrossSiteForm(req('POST', 'application/x-www-form-urlencoded', 'https://os.kindred.test'), url('/login'))).toBe(false)
    expect(isForbiddenCrossSiteForm(req('POST', 'application/json', 'https://evil.test'), url('/api/mail/send'))).toBe(false)
    expect(isForbiddenCrossSiteForm(req('GET', 'text/plain', 'https://evil.test'), url('/'))).toBe(false)
  })

  it('exempts only the SNS callback (signature-verified), not its neighbours', () => {
    expect(isForbiddenCrossSiteForm(req('POST', 'text/plain; charset=UTF-8', null), url('/api/mail/ses-events'))).toBe(false)
    expect(isCsrfExempt('/api/mail/ses-events-x')).toBe(false)
    expect(isForbiddenCrossSiteForm(req('POST', 'text/plain; charset=UTF-8', null), url('/api/mail/ses-inbound'))).toBe(false)
    expect(isCsrfExempt('/api/mail/ses-inbound-x')).toBe(false)
    expect(isForbiddenCrossSiteForm(req('POST', 'text/plain', null), url('/api/mail/send'))).toBe(true)
    // RFC 8058 one-click unsubscribe from mailbox providers (token-authorised).
    expect(isForbiddenCrossSiteForm(req('POST', 'application/x-www-form-urlencoded', null), url('/api/mail/unsubscribe/abc'))).toBe(false)
  })

  it('answers 403 in the shape the client asked for', async () => {
    const r = csrfRefusal(new Request('https://x.test', { method: 'POST', headers: { accept: 'application/json' } }))
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ message: 'Cross-site POST form submissions are forbidden' })
  })
})
