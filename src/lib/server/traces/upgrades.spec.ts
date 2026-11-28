import { describe, expect, it } from 'vitest'
import { toHubSpansV1 } from '../../../../modules/traces/payload'
import { upgradeRowsFrom } from './upgrades'

const R = 'eigenenterprise-0.5.48-aaaaaaaaaaaa'
const outcomes = [
  { id: 'e2', at: '2026-11-22T03:00:00.000Z', release: R, step: 'watching' as const, ok: false, rolledBack: true },
  { id: 'e1', at: '2026-11-21T03:00:00.000Z', release: R, step: 'done' as const, ok: true, rolledBack: false },
]

describe('upgrade outcomes as trace rows (plan/traces-phone-home.md T5)', () => {
  it('reads after the cursor and before `until`, oldest first; the span says rolled_back at the step, on the release', () => {
    const rows = upgradeRowsFrom(outcomes, { at: new Date('2026-11-21T03:00:00.000Z'), id: 'e1' }, new Date('2026-11-23T00:00:00Z'), 10)
    expect(rows.map((r) => r.localId)).toEqual(['e2'])
    const [span] = toHubSpansV1(rows, { appVersion: '0.5.47', eeVersion: null, salt: 's', values: { verdict: () => 'unclassified' } }).spans
    expect(span).toMatchObject({ kind: 'upgrade', outcome: 'rolled_back', error_code: 'upgrade_step:watching', app_version: R })
  })
})
