import { describe, expect, it } from 'vitest'
import {
  evaluateReputation,
  reputationRefusal,
  type AwsReputation,
  type LedgerRow,
} from './reputation'

/** n sends of one recipient each from one slice, with `bounces` hard bounces and `complaints` complaints among them. */
function mails(
  n: number,
  o: {
    bounces?: number
    complaints?: number
    origin?: string
    sender?: string | null
    ref?: string | null
    prefix?: string
  } = {},
): LedgerRow[] {
  const rows: LedgerRow[] = []
  const dims = {
    origin: o.origin ?? 'api',
    sender: o.sender === undefined ? 'hello@acme.com' : o.sender,
    ref: o.ref ?? null,
  }
  const p = o.prefix ?? o.origin ?? 'm'
  for (let i = 0; i < n; i++) {
    const id = `${p}-${i}`
    rows.push({ sesMessageId: id, kind: 'send', recipients: 1, ...dims })
    if (i < (o.bounces ?? 0))
      rows.push({ sesMessageId: id, kind: 'hard_bounce', recipients: 1, ...dims })
    else if (i < (o.bounces ?? 0) + (o.complaints ?? 0))
      rows.push({ sesMessageId: id, kind: 'complaint', recipients: 1, ...dims })
  }
  return rows
}

const healthyAws: AwsReputation = { mode: 'own', enforcement: 'HEALTHY', sendingEnabled: true }

describe('evaluateReputation', () => {
  it('is unjudged below 100 recipients, however bad', () => {
    const s = evaluateReputation(mails(50, { bounces: 25 }), healthyAws)
    expect(s.band).toBe('unjudged')
    expect(s.rates).toMatchObject({ recipients: 50, bounces: 25, bounceRate: 0.5 })
    expect(s.sendingHeld).toBe(false)
  })

  it('healthy under 2% bounces; watch from 2%; held from 5% (Amazon review level)', () => {
    expect(evaluateReputation(mails(1000, { bounces: 19 }), healthyAws).band).toBe('healthy')
    expect(evaluateReputation(mails(1000, { bounces: 20 }), healthyAws).band).toBe('watch')
    const held = evaluateReputation(mails(1000, { bounces: 50 }), healthyAws)
    expect(held.band).toBe('held')
    expect(held.sendingHeld).toBe(true)
    expect(held.reasons.join(' ')).toContain('5.0% of your recent mail bounced')
  })

  it('judges complaints only from 1,000 recipients: watch from 0.05%, held from 0.1%', () => {
    expect(evaluateReputation(mails(999, { complaints: 5 }), healthyAws).band).toBe('healthy')
    expect(evaluateReputation(mails(2000, { complaints: 1 }), healthyAws).band).toBe('watch')
    expect(evaluateReputation(mails(2000, { complaints: 2 }), healthyAws).band).toBe('held')
  })

  it('counts per recipient and only bounces of mails in the window', () => {
    const rows: LedgerRow[] = [
      ...mails(99),
      {
        sesMessageId: 'multi',
        kind: 'send',
        recipients: 3,
        origin: 'webmail',
        sender: null,
        ref: null,
      },
      {
        sesMessageId: 'multi',
        kind: 'hard_bounce',
        recipients: 2,
        origin: 'webmail',
        sender: null,
        ref: null,
      },
      // A bounce whose Send is outside the window (or never arrived) is not counted.
      {
        sesMessageId: 'gone',
        kind: 'hard_bounce',
        recipients: 1,
        origin: 'api',
        sender: 'hello@acme.com',
        ref: null,
      },
    ]
    expect(evaluateReputation(rows, healthyAws).rates).toMatchObject({
      recipients: 102,
      bounces: 2,
    })
  })

  it("Amazon's verdict wins: PROBATION holds, SHUTDOWN / sending off / tenant DISABLED pause, REINSTATED watches", () => {
    const clean = mails(1000)
    expect(
      evaluateReputation(clean, { mode: 'own', enforcement: 'PROBATION', sendingEnabled: true })
        .band,
    ).toBe('held')
    expect(
      evaluateReputation(clean, { mode: 'own', enforcement: 'SHUTDOWN', sendingEnabled: true })
        .band,
    ).toBe('paused')
    expect(
      evaluateReputation(clean, { mode: 'own', enforcement: 'HEALTHY', sendingEnabled: false })
        .band,
    ).toBe('paused')
    expect(evaluateReputation(clean, { mode: 'managed', sendingStatus: 'DISABLED' }).band).toBe(
      'paused',
    )
    expect(evaluateReputation(clean, { mode: 'managed', sendingStatus: 'REINSTATED' }).band).toBe(
      'watch',
    )
    expect(
      evaluateReputation(mails(10), { mode: 'own', enforcement: 'PROBATION', sendingEnabled: true })
        .band,
    ).toBe('held')
  })

  it('flags a slice over the watch line and holds it over the review line, while the company stays healthy', () => {
    const rows = [
      ...mails(3000, { origin: 'agent', prefix: 'a' }),
      ...mails(60, {
        origin: 'flow',
        ref: 'flow:f1',
        sender: 'news@acme.com',
        bounces: 6,
        prefix: 'f',
      }),
      ...mails(100, { origin: 'api', ref: 'api_key:k1', bounces: 3, prefix: 'k' }),
    ]
    const s = evaluateReputation(rows, healthyAws)
    expect(s.band).toBe('healthy')
    expect(s.slices.find((x) => x.dimension === 'ref' && x.value === 'flow:f1')).toMatchObject({
      band: 'held',
      bounces: 6,
    })
    expect(
      s.slices.find((x) => x.dimension === 'sender' && x.value === 'news@acme.com'),
    ).toMatchObject({ band: 'held' })
    expect(s.slices.find((x) => x.dimension === 'ref' && x.value === 'api_key:k1')).toMatchObject({
      band: 'watch',
    })
    // Healthy slices are not listed.
    expect(s.slices.find((x) => x.value === 'agent')).toBeUndefined()
  })

  it('without delivery events there is nothing to judge but Amazon', () => {
    const s = evaluateReputation([], healthyAws, { tracking: false })
    expect(s.band).toBe('unjudged')
    expect(s.tracking).toBe(false)
  })
})

describe('reputationRefusal', () => {
  it('refuses every mail but system mail while the company is held', () => {
    const s = evaluateReputation(mails(1000, { bounces: 60 }), healthyAws)
    expect(reputationRefusal(s, { origin: 'agent', sender: 'hello@acme.com', ref: null })).toMatch(
      /on hold/,
    )
    expect(reputationRefusal(s, { origin: 'webmail', sender: null, ref: null })).toMatch(/on hold/)
    expect(
      reputationRefusal(s, { origin: 'system', sender: 'hello@acme.com', ref: null }),
    ).toBeNull()
  })

  it('refuses only the held slice', () => {
    const rows = [
      ...mails(3000, { origin: 'agent', prefix: 'a' }),
      ...mails(60, {
        origin: 'flow',
        ref: 'flow:f1',
        sender: 'news@acme.com',
        bounces: 6,
        prefix: 'f',
      }),
    ]
    const s = evaluateReputation(rows, healthyAws)
    expect(
      reputationRefusal(s, { origin: 'flow', sender: 'news@acme.com', ref: 'flow:f1' }),
    ).toMatch(/This flow’s mail is on hold/)
    expect(
      reputationRefusal(s, { origin: 'agent', sender: 'hello@acme.com', ref: null }),
    ).toBeNull()
  })

  it('names Amazon when Amazon paused the account', () => {
    const s = evaluateReputation(mails(10), {
      mode: 'own',
      enforcement: 'SHUTDOWN',
      sendingEnabled: true,
    })
    expect(reputationRefusal(s, { origin: 'api', sender: 'hello@acme.com', ref: null })).toMatch(
      /Amazon SES paused sending/,
    )
  })
})
