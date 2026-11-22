import { describe, expect, it } from 'vitest'
import {
  callsRecords,
  claimRecord,
  fromMailRecords,
  webRecords,
  type MailRecordInput,
} from './records'

describe('webRecords', () => {
  it('is an A record on the host when only IPv4 is known', () => {
    expect(webRecords({ host: 'one.kindred.com', ipv4: '203.0.113.7', ipv6: null })).toEqual([
      { name: 'one.kindred.com', type: 'A', value: '203.0.113.7', purpose: 'web' },
    ])
  })

  it('adds AAAA when the box has a public IPv6 address', () => {
    expect(webRecords({ host: 'kindred.com', ipv4: '203.0.113.7', ipv6: '2001:db8::7' })).toEqual([
      { name: 'kindred.com', type: 'A', value: '203.0.113.7', purpose: 'web' },
      { name: 'kindred.com', type: 'AAAA', value: '2001:db8::7', purpose: 'web' },
    ])
  })

  it('normalises the host to a lowercase FQDN without trailing dot', () => {
    expect(webRecords({ host: 'One.Kindred.COM.', ipv4: '203.0.113.7', ipv6: null })[0].name).toBe(
      'one.kindred.com',
    )
  })

  it('refuses an empty host', () => {
    expect(() => webRecords({ host: ' ', ipv4: '203.0.113.7', ipv6: null })).toThrow(/host/)
  })

  it('refuses an empty IPv4 address', () => {
    expect(() => webRecords({ host: 'kindred.com', ipv4: '', ipv6: null })).toThrow(/IPv4/)
  })
})

describe('claimRecord', () => {
  it('is the _ee-verify TXT the control plane checks', () => {
    expect(claimRecord({ host: 'shop.kindred.com', token: 'ee-abc123' })).toEqual({
      name: '_ee-verify.shop.kindred.com',
      type: 'TXT',
      value: 'ee-abc123',
      purpose: 'claim',
    })
  })

  it('refuses an empty token', () => {
    expect(() => claimRecord({ host: 'shop.kindred.com', token: '' })).toThrow(/token/)
  })
})

describe('callsRecords', () => {
  it('is an A record on the calls host', () => {
    expect(callsRecords({ host: 'rtc.one.kindred.com', ipv4: '203.0.113.7' })).toEqual([
      { name: 'rtc.one.kindred.com', type: 'A', value: '203.0.113.7', purpose: 'calls' },
    ])
  })
})

describe('fromMailRecords', () => {
  // The shape modules/email/platform/dns.ts dnsRecords() returns (extra fields are ignored).
  const mail: MailRecordInput[] = [
    {
      purpose: 'dkim',
      type: 'TXT',
      name: 'ee._domainkey.kindred.com',
      value: 'p=MIIB',
      priority: null,
    },
    {
      purpose: 'mail_from_mx',
      type: 'MX',
      name: 'mail.kindred.com',
      value: 'feedback-smtp.eu-central-1.amazonses.com',
      priority: 10,
    },
    {
      purpose: 'spf',
      type: 'TXT',
      name: 'mail.kindred.com',
      value: 'v=spf1 include:amazonses.com ~all',
      priority: null,
    },
    {
      purpose: 'dmarc',
      type: 'TXT',
      name: '_dmarc.kindred.com',
      value: 'v=DMARC1; p=none;',
      priority: null,
    },
  ]

  it('maps each mail record to an expected record, keeping MX priority', () => {
    expect(fromMailRecords(mail)).toEqual([
      { name: 'ee._domainkey.kindred.com', type: 'TXT', value: 'p=MIIB', purpose: 'mail_dkim' },
      {
        name: 'mail.kindred.com',
        type: 'MX',
        value: 'feedback-smtp.eu-central-1.amazonses.com',
        priority: 10,
        purpose: 'mail_mail_from_mx',
      },
      {
        name: 'mail.kindred.com',
        type: 'TXT',
        value: 'v=spf1 include:amazonses.com ~all',
        purpose: 'mail_spf',
      },
      {
        name: '_dmarc.kindred.com',
        type: 'TXT',
        value: 'v=DMARC1; p=none;',
        purpose: 'mail_dmarc',
      },
    ])
  })

  it('maps Easy DKIM CNAMEs', () => {
    expect(
      fromMailRecords([
        {
          purpose: 'dkim',
          type: 'CNAME',
          name: 'tok1._domainkey.kindred.com',
          value: 'tok1.dkim.amazonses.com',
          priority: null,
        },
      ]),
    ).toEqual([
      {
        name: 'tok1._domainkey.kindred.com',
        type: 'CNAME',
        value: 'tok1.dkim.amazonses.com',
        purpose: 'mail_dkim',
      },
    ])
  })

  it('leaves out a DKIM key published outside ee (its value is unknown, so nothing can be compared)', () => {
    expect(
      fromMailRecords([
        {
          purpose: 'dkim',
          type: 'TXT',
          name: 'ee._domainkey.kindred.com',
          value: null,
          priority: null,
        },
      ]),
    ).toEqual([])
  })
})
