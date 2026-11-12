import { createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  dnsRecords,
  generateDkimKeyPair,
  inboundMxSeen,
  InvalidDomainError,
  mailFromDomain,
  normalizeDomain,
  registrableDomain,
} from './dns'

const domain = (over: Partial<Parameters<typeof dnsRecords>[0]> = {}) => ({
  name: 'kindred.com',
  region: 'eu-central-1',
  dkimSelector: 'ee',
  publicKey: 'MIIBIjANBgkqh',
  dkimStatus: 'PENDING',
  mailFromStatus: 'PENDING',
  dmarcAdded: false,
  ...over,
})

describe('normalizeDomain', () => {
  it('lowercases and strips scheme, path and trailing dot', () => {
    expect(normalizeDomain('  Kindred.COM ')).toBe('kindred.com')
    expect(normalizeDomain('https://news.kindred.com/about')).toBe('news.kindred.com')
    expect(normalizeDomain('kindred.co.uk.')).toBe('kindred.co.uk')
  })

  it('refuses addresses, bare suffixes and junk in plain words', () => {
    expect(() => normalizeDomain('hello@kindred.com')).toThrow(/not an email address/)
    expect(() => normalizeDomain('co.uk')).toThrow(InvalidDomainError)
    expect(() => normalizeDomain('kin dred.com')).toThrow(/is not a domain name/)
    expect(() => normalizeDomain('-bad.com')).toThrow(InvalidDomainError)
    expect(() => normalizeDomain('')).toThrow(/Enter a domain/)
  })
})

describe('dnsRecords', () => {
  it('lists DKIM, MAIL FROM MX + SPF and the recommended DMARC record with zone-relative hosts', () => {
    expect(dnsRecords(domain(), null)).toEqual([
      {
        purpose: 'dkim',
        type: 'TXT',
        name: 'ee._domainkey.kindred.com',
        host: 'ee._domainkey',
        value: 'p=MIIBIjANBgkqh',
        priority: null,
        status: 'PENDING',
        required: true,
      },
      {
        purpose: 'mail_from_mx',
        type: 'MX',
        name: 'mail.kindred.com',
        host: 'mail',
        value: 'feedback-smtp.eu-central-1.amazonses.com',
        priority: 10,
        status: 'PENDING',
        required: true,
      },
      {
        purpose: 'spf',
        type: 'TXT',
        name: 'mail.kindred.com',
        host: 'mail',
        value: 'v=spf1 include:amazonses.com ~all',
        priority: null,
        status: 'PENDING',
        required: true,
      },
      {
        purpose: 'dmarc',
        type: 'TXT',
        name: '_dmarc.kindred.com',
        host: '_dmarc',
        value: 'v=DMARC1; p=none;',
        priority: null,
        status: 'NOT_STARTED',
        required: false,
      },
    ])
  })

  it('places a subdomain’s records under the subdomain and DMARC at the registrable domain', () => {
    const records = dnsRecords(domain({ name: 'news.kindred.co.uk', dkimStatus: 'SUCCESS', mailFromStatus: 'FAILED', dmarcAdded: true }), null)
    expect(records.map((r) => [r.purpose, r.name, r.host, r.status])).toEqual([
      ['dkim', 'ee._domainkey.news.kindred.co.uk', 'ee._domainkey.news', 'SUCCESS'],
      ['mail_from_mx', 'mail.news.kindred.co.uk', 'mail.news', 'FAILED'],
      ['spf', 'mail.news.kindred.co.uk', 'mail.news', 'FAILED'],
      ['dmarc', '_dmarc.kindred.co.uk', '_dmarc', 'SUCCESS'],
    ])
    expect(registrableDomain('news.kindred.co.uk')).toBe('kindred.co.uk')
    expect(mailFromDomain('kindred.com')).toBe('mail.kindred.com')
  })

  it('adds the receiving MX on the domain itself only while receiving is on', () => {
    expect(dnsRecords(domain(), 'PENDING').at(-1)).toEqual({
      purpose: 'inbound_mx',
      type: 'MX',
      name: 'kindred.com',
      host: '@',
      value: 'inbound-smtp.eu-central-1.amazonaws.com',
      priority: 10,
      status: 'PENDING',
      required: true,
    })
    expect(dnsRecords(domain({ name: 'news.kindred.com' }), 'SUCCESS').at(-1)).toMatchObject({ name: 'news.kindred.com', host: 'news' })
    expect(dnsRecords(domain(), null).some((r) => r.purpose === 'inbound_mx')).toBe(false)
  })

  it('sees the receiving MX only when an MX record points exactly at SES in the region', () => {
    expect(inboundMxSeen([{ exchange: 'Inbound-SMTP.eu-central-1.amazonaws.com.', priority: 10 }], 'eu-central-1')).toBe(true)
    expect(inboundMxSeen([{ exchange: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 }], 'eu-central-1')).toBe(false)
    expect(inboundMxSeen([{ exchange: 'aspmx.l.google.com', priority: 1 }], 'eu-central-1')).toBe(false)
    expect(inboundMxSeen([], 'eu-central-1')).toBe(false)
  })

  it('maps unknown SES states to NOT_STARTED', () => {
    expect(dnsRecords(domain({ dkimStatus: 'weird' }), null)[0]!.status).toBe('NOT_STARTED')
  })
})

describe('generateDkimKeyPair', () => {
  it('produces a matching 2048-bit RSA pair as bare base64 (no PEM armour)', () => {
    const { privateKey, publicKey } = generateDkimKeyPair()
    expect(privateKey).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(publicKey).toMatch(/^[A-Za-z0-9+/=]+$/)
    const priv = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    const pub = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    expect(pub.asymmetricKeyDetails?.modulusLength).toBe(2048)
    const sig = createSign('RSA-SHA256').update('x').sign(priv)
    expect(createVerify('RSA-SHA256').update('x').verify(pub, sig)).toBe(true)
  })
})
