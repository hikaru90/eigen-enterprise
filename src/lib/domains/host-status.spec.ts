import { describe, expect, it } from 'vitest'
import {
  decodeShows,
  dnsSummary,
  encodeShows,
  hostReadiness,
  recordsToFix,
  targetChoices,
  type HostView,
  type ObservedRecord,
} from './host-status'

const rec = (status: ObservedRecord['status'], name = 'acme.eu'): ObservedRecord => ({
  name,
  type: 'A',
  value: '203.0.113.7',
  purpose: 'web',
  status,
  observed: status === 'wrong' ? ['198.51.100.1'] : [],
  error: status === 'lookup_failed' ? 'ETIMEOUT' : null,
})

const host = (o: Partial<HostView> = {}): HostView => ({
  host: 'acme.eu',
  shows: { kind: 'site' },
  email: null,
  records: [rec('ok')],
  claim: null,
  certificate: {
    host: 'acme.eu',
    state: 'issued',
    lastError: null,
    nextRetryAt: null,
    notAfter: '2027-01-01T00:00:00Z',
  },
  ...o,
})

describe('host status (structure over domains.list)', () => {
  it('records to fix are the missing and wrong ones, never a failed lookup', () => {
    expect(
      recordsToFix([rec('ok'), rec('missing'), rec('wrong'), rec('lookup_failed')]).map(
        (r) => r.status,
      ),
    ).toEqual(['missing', 'wrong'])
  })

  it('DNS summary: all ok / N to fix / could not be checked', () => {
    expect(dnsSummary([rec('ok')]).label).toBe('All ok')
    expect(dnsSummary([rec('missing'), rec('wrong')]).label).toBe('2 to fix')
    expect(dnsSummary([rec('lookup_failed')]).label).toBe('1 could not be checked')
  })

  it('readiness in the order it fails: DNS, then claim, then certificate', () => {
    expect(hostReadiness(host())).toEqual({ tone: 'ok', label: 'Live' })
    expect(
      hostReadiness(host({ records: [rec('missing')], claim: { verified: false } })).label,
    ).toBe('DNS: 1 to fix')
    expect(hostReadiness(host({ claim: { verified: false } })).label).toBe(
      'Waiting for the TXT record',
    )
    const failing = host({
      certificate: {
        host: 'acme.eu',
        state: 'failing',
        lastError: 'NXDOMAIN',
        nextRetryAt: null,
        notAfter: null,
      },
    })
    expect(hostReadiness(failing)).toEqual({ tone: 'failing', label: 'Certificate failing' })
  })

  it('targets round-trip through one form value; anything else is refused', () => {
    for (const t of targetChoices(['shop'])) expect(decodeShows(encodeShows(t))).toEqual(t)
    expect(targetChoices(['shop']).map(encodeShows)).toEqual([
      'console',
      'site',
      'app:shop',
      'nothing',
    ])
    expect(decodeShows('calls')).toBeNull()
    expect(decodeShows('app:')).toBeNull()
  })
})
