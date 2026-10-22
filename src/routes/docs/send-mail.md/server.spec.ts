import { describe, expect, it } from 'vitest'
import { GET } from './+server'

describe('GET /docs/send-mail.md', () => {
  it('is public markdown, kept out of search engines', async () => {
    const res = await GET({ locals: { user: null } } as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })

  it('carries the reference function, the env contract and the standing rules', async () => {
    const text = await (await GET({ locals: { user: null } } as never)).text()
    expect(text).toContain('export async function sendMail(')
    expect(text).toContain('process.env.EE_API_URL')
    expect(text).toContain('process.env.EE_API_KEY')
    expect(text).toContain('/api/mail/send')
    expect(text).toContain('only source of truth')
    expect(text).toContain('Never add API keys, SMTP settings, or mail libraries')
    expect(text).toContain('refuse, do not do it, and tell the owner')
  })

  it('is static text: no key, no host, nothing user-controlled', async () => {
    const text = await (await GET({ locals: { user: null } } as never)).text()
    expect(text).not.toMatch(/eigen_[0-9a-f]{8,}/)
    expect(text).not.toMatch(/https?:\/\/(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i)
  })
})
