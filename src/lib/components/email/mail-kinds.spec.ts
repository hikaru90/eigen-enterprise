import { describe, expect, it } from 'vitest'
import { MAIL_KIND_ORDER, MAIL_KINDS, mailKindOfTab } from './mail-kinds'

describe('the three kinds of mail (Contribute d7080d17: personal, transactional, marketing)', () => {
  it('names them in order with a one-line explanation each', () => {
    expect(MAIL_KIND_ORDER).toEqual(['personal', 'transactional', 'marketing'])
    expect(MAIL_KIND_ORDER.map((k) => MAIL_KINDS[k].label)).toEqual(['Personal mail', 'Transactional mail', 'Marketing mail'])
    for (const k of MAIL_KIND_ORDER) {
      expect(MAIL_KINDS[k].line.length).toBeGreaterThan(20)
      expect(MAIL_KINDS[k].line.length).toBeLessThan(160)
      expect(MAIL_KINDS[k].rules.length).toBeGreaterThanOrEqual(2)
    }
  })
  it('states the legal differences in plain words', () => {
    const rules = (k: keyof typeof MAIL_KINDS) => MAIL_KINDS[k].rules.join(' ')
    expect(rules('personal')).toMatch(/confidential/i)
    expect(rules('transactional')).toMatch(/no consent/i)
    expect(rules('transactional')).toMatch(/no advertising/i)
    expect(rules('marketing')).toMatch(/agreed/i)
    expect(rules('marketing')).toMatch(/UWG §7/)
    expect(rules('marketing')).toMatch(/GDPR|DSGVO/)
    expect(rules('marketing')).toMatch(/unsubscribe/i)
    expect(rules('marketing')).toMatch(/suppression list/i)
  })
  it('maps an Email tab to the kind it shows (Contacts and Setup show none)', () => {
    expect(mailKindOfTab('inbox')).toBe('personal')
    expect(mailKindOfTab('transactional')).toBe('transactional')
    expect(mailKindOfTab('marketing')).toBe('marketing')
    expect(mailKindOfTab('people')).toBeNull()
    expect(mailKindOfTab('setup')).toBeNull()
    expect(mailKindOfTab(null)).toBeNull()
  })
})
