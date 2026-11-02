import { describe, expect, it } from 'vitest'
import { resolveMailTransport } from './transport'

describe('resolveMailTransport', () => {
  it('absence means Amazon SES', () => {
    expect(resolveMailTransport({})).toBe('ses')
    expect(resolveMailTransport({ NODE_ENV: 'production' })).toBe('ses')
  })

  it('accepts the explicit ses value', () => {
    expect(resolveMailTransport({ MAIL_TRANSPORT: 'ses', NODE_ENV: 'production' })).toBe('ses')
  })

  it('accepts fake outside production', () => {
    expect(resolveMailTransport({ MAIL_TRANSPORT: 'fake', NODE_ENV: 'development' })).toBe('fake')
    expect(resolveMailTransport({ MAIL_TRANSPORT: 'fake' })).toBe('fake')
  })

  it('refuses fake in production without the second switch', () => {
    expect(() => resolveMailTransport({ MAIL_TRANSPORT: 'fake', NODE_ENV: 'production' })).toThrow(
      /MAIL_TRANSPORT_FAKE_IN_PRODUCTION=1/,
    )
  })

  it('allows fake in production with MAIL_TRANSPORT_FAKE_IN_PRODUCTION=1 (the local test server)', () => {
    expect(
      resolveMailTransport({ MAIL_TRANSPORT: 'fake', NODE_ENV: 'production', MAIL_TRANSPORT_FAKE_IN_PRODUCTION: '1' }),
    ).toBe('fake')
  })

  it('fails loud on unknown or empty values', () => {
    expect(() => resolveMailTransport({ MAIL_TRANSPORT: 'smtp' })).toThrow(/MAIL_TRANSPORT="smtp"/)
    expect(() => resolveMailTransport({ MAIL_TRANSPORT: '' })).toThrow(/MAIL_TRANSPORT=""/)
    expect(() => resolveMailTransport({ MAIL_TRANSPORT: 'FAKE' })).toThrow(/MAIL_TRANSPORT/)
  })

  it('fails loud on a malformed or meaningless override switch', () => {
    expect(() =>
      resolveMailTransport({ MAIL_TRANSPORT: 'fake', NODE_ENV: 'production', MAIL_TRANSPORT_FAKE_IN_PRODUCTION: 'yes' }),
    ).toThrow(/MAIL_TRANSPORT_FAKE_IN_PRODUCTION/)
    expect(() => resolveMailTransport({ MAIL_TRANSPORT_FAKE_IN_PRODUCTION: '1' })).toThrow(/only means something/)
  })
})
