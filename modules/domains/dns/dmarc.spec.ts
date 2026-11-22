import { describe, expect, it } from 'vitest'
import { dmarcPolicy, dmarcSatisfied, parseDmarcTags } from './dmarc'

describe('DMARC tag-value syntax (RFC 7489 §6.3)', () => {
  it('parses tag=value pairs, tag names case-insensitive, whitespace around them ignored', () => {
    expect(
      Object.fromEntries(parseDmarcTags('v=DMARC1; P = Quarantine ;rua=mailto:d@acme.eu;')!),
    ).toEqual({ v: 'DMARC1', p: 'Quarantine', rua: 'mailto:d@acme.eu' })
  })

  it('v=DMARC1 must come first and is case-sensitive', () => {
    expect(parseDmarcTags('p=none; v=DMARC1')).toBeNull()
    expect(parseDmarcTags('v=dmarc1; p=none')).toBeNull()
    expect(parseDmarcTags('v=spf1 include:amazonses.com ~all')).toBeNull()
  })

  it('malformed parts and repeated tags are not a DMARC record', () => {
    expect(parseDmarcTags('v=DMARC1;; p=none')).toBeNull()
    expect(parseDmarcTags('v=DMARC1; none')).toBeNull()
    expect(parseDmarcTags('v=DMARC1; p=none; p=reject')).toBeNull()
  })

  it('the policy is none, quarantine or reject (values case-insensitive)', () => {
    expect(dmarcPolicy('v=DMARC1; p=none;')).toBe('none')
    expect(dmarcPolicy('v=DMARC1; p=QUARANTINE; pct=50')).toBe('quarantine')
    expect(dmarcPolicy('v=DMARC1;p=reject')).toBe('reject')
    expect(dmarcPolicy('v=DMARC1; p=block')).toBeNull()
    expect(dmarcPolicy('v=DMARC1; rua=mailto:d@acme.eu')).toBeNull()
  })
})

describe('dmarcSatisfied: the answers at _dmarc.<domain>', () => {
  it('one valid DMARC record with any policy is ok; unrelated TXT records are ignored', () => {
    expect(dmarcSatisfied(['v=DMARC1; p=reject; rua=mailto:d@acme.eu'])).toBe(true)
    expect(dmarcSatisfied(['google-site-verification=abc', 'v=DMARC1; p=quarantine'])).toBe(true)
  })

  it('no DMARC record, an invalid one, or two of them (§6.6.3: none applies) is not', () => {
    expect(dmarcSatisfied(['google-site-verification=abc'])).toBe(false)
    expect(dmarcSatisfied(['v=DMARC1; p=maybe'])).toBe(false)
    expect(dmarcSatisfied(['v=DMARC1; p=none', 'v=DMARC1; p=reject'])).toBe(false)
  })
})
