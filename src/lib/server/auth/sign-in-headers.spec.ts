import { describe, expect, it } from 'vitest'
import { signInHeaders } from './sign-in-headers'

const event = (headers: Record<string, string>, address: string | Error = '198.51.100.4') => ({
  request: new Request('http://localhost/login', { headers }),
  getClientAddress: () => {
    if (address instanceof Error) throw address
    return address
  },
})

describe('signInHeaders', () => {
  it('passes the user agent and the client address to the session', () => {
    const h = signInHeaders(event({ 'user-agent': 'UA/1', cookie: 'secret=1' }))
    expect(h.get('user-agent')).toBe('UA/1')
    expect(h.get('x-forwarded-for')).toBe('198.51.100.4')
    expect(h.get('cookie')).toBeNull()
  })
  it('keeps a proxy-set forwarded address', () => {
    expect(signInHeaders(event({ 'x-forwarded-for': '203.0.113.9' })).get('x-forwarded-for')).toBe(
      '203.0.113.9',
    )
  })
  it('records no address when none is known', () => {
    expect(signInHeaders(event({}, new Error('no address'))).get('x-forwarded-for')).toBeNull()
  })
})
