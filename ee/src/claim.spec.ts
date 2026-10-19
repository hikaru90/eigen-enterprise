import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { claimUrl, newClaim } from './claim.ts'

describe('claim link', () => {
  it('keeps only the hash on the server, expiring in 7 days', () => {
    const now = new Date('2026-10-19T12:00:00Z')
    const c = newClaim(now)
    expect(c.token.length).toBeGreaterThanOrEqual(32)
    expect(c.hash).toBe(createHash('sha256').update(c.token).digest('hex'))
    expect(c.expiresAt).toBe('2026-10-26T12:00:00.000Z')
    expect(newClaim(now).token).not.toBe(c.token)
  })
  it('builds the console link', () => {
    expect(claimUrl('os.kindred.digital', 'a+b')).toBe('https://os.kindred.digital/claim?token=a%2Bb')
  })
})
