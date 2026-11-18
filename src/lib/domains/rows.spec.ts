import type { BoughtDomain } from './contract'
import { describe, expect, it } from 'vitest'
import { domainRows } from './rows'

const b = (name: string, state: BoughtDomain['state']): BoughtDomain => ({
  name,
  state,
  error: state === 'failed' ? 'Registry refused.' : null,
  renewsAt: state === 'active' ? '2027-11-18T00:00:00.000Z' : null,
  autoRenew: true,
})
const m = (name: string) => ({ id: `id-${name}`, name, status: 'SUCCESS', sendable: true, receiving: true })

describe('domainRows (Settings › Domains)', () => {
  it('bought domains first with their mail domain; then domains connected from the company’s DNS', () => {
    const rows = domainRows([b('acme.eu', 'active')], [m('acme.eu'), m('acme.test')], 'managed')
    expect(rows.map((r) => [r.name, r.source, r.mail?.id ?? null])).toEqual([
      ['acme.eu', 'bought', 'id-acme.eu'],
      ['acme.test', 'connected', 'id-acme.test'],
    ])
    expect(rows[0]).toMatchObject({ state: 'active', renewsAt: '2027-11-18T00:00:00.000Z', autoRenew: true, mailNote: null })
  })

  it('a bought domain not yet a mail domain says why, in plain words', () => {
    expect(domainRows([b('a.eu', 'configuring')], [], 'managed')[0].mailNote).toMatch(/Becoming a mail domain/)
    expect(domainRows([b('a.eu', 'registering')], [], 'managed')[0].mailNote).toBeNull()
    expect(domainRows([b('a.eu', 'active')], [], 'own')[0].mailNote).toMatch(/your own Amazon SES/)
    expect(domainRows([b('a.eu', 'failed')], [], 'managed')[0]).toMatchObject({ mailNote: null, error: 'Registry refused.' })
  })
})
