import { describe, expect, it } from 'vitest'
import { HUB_CONTRIBUTION_KEYS } from './contract'
import { payloadBody, payloadHash, toHubPayload, utcDay, type PayloadSource } from './payload'

const row = (over: Partial<PayloadSource> = {}): PayloadSource => ({
  id: '0b6f7c1e-4a2d-4c8e-9f10-2b3c4d5e6f70',
  kind: 'bug',
  area: 'drive',
  status: 'shipped',
  score: 4,
  createdAt: new Date('2026-11-12T23:59:59.999Z'),
  shippedAt: new Date('2026-11-13T00:00:00.000Z'),
  ...over,
})

const scrubbed = { summary: 'Uploading a folder to Drive fails for large files.', language: 'de' }

describe('toHubPayload', () => {
  it('builds exactly the contract fields: net score, UTC days, never a timestamp', () => {
    const p = toHubPayload(row(), scrubbed, '0.5.9')
    expect(Object.keys(p).sort()).toEqual([...HUB_CONTRIBUTION_KEYS].sort())
    expect(p).toEqual({
      v: 1,
      remote_id: '0b6f7c1e-4a2d-4c8e-9f10-2b3c4d5e6f70',
      summary: scrubbed.summary,
      language: 'de',
      kind: 'bug',
      area: 'drive',
      status: 'shipped',
      score: 4,
      app_version: '0.5.9',
      created_day: '2026-11-12',
      shipped_day: '2026-11-13',
    })
  })

  it('carries no author, title, note, votes or exact time even when the row has them', () => {
    const withExtras = { ...row({ shippedAt: null, status: 'requested' }), title: 'Ana: my link https://kindred.example', authorId: 'ana', note: 'x', votes: new Map([['ana', 1]]) }
    const p = toHubPayload(withExtras as PayloadSource, scrubbed, '0.5.9')
    const body = payloadBody(p)
    for (const leak of ['Ana', 'kindred', 'ana', 'T23:59']) expect(body).not.toContain(leak)
    expect(p.shipped_day).toBeNull()
  })

  it('fails loud when the result breaks the contract (an empty summary, a bad version)', () => {
    expect(() => toHubPayload(row(), { summary: '', language: 'de' }, '0.5.9')).toThrow()
    expect(() => toHubPayload(row(), scrubbed, '')).toThrow()
    expect(() => toHubPayload(row({ id: 'not-a-uuid' }), scrubbed, '0.5.9')).toThrow()
  })
})

describe('payloadHash', () => {
  it('is stable for the same payload and changes with any field', () => {
    const a = toHubPayload(row(), scrubbed, '0.5.9')
    expect(payloadHash(a)).toBe(payloadHash({ ...a }))
    expect(payloadHash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(payloadHash({ ...a, score: 5 })).not.toBe(payloadHash(a))
    expect(payloadHash({ ...a, status: 'declined' })).not.toBe(payloadHash(a))
  })

  it('does not depend on key order (the body is canonical)', () => {
    const a = toHubPayload(row(), scrubbed, '0.5.9')
    const reversed = Object.fromEntries(Object.entries(a).reverse()) as typeof a
    expect(payloadBody(reversed)).toBe(payloadBody(a))
    expect(payloadHash(reversed)).toBe(payloadHash(a))
  })
})

describe('utcDay', () => {
  it('is the UTC calendar day', () => {
    expect(utcDay(new Date('2026-01-02T00:30:00+02:00'))).toBe('2026-01-01')
  })
})
