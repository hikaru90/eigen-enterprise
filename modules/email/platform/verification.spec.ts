import { describe, expect, it } from 'vitest'
import { NO_DOMAIN_IDENTITY } from '../owlery/ses'
import { applyIdentityCheck, dueForCheck, isSendable, verificationErrorMessage } from './verification'

const now = new Date('2026-11-04T12:00:00Z')
const check = (verification: string, dkim = verification, mailFrom = verification, errorType: string | null = null) => ({
  exists: true,
  verification,
  dkim,
  mailFrom,
  errorType,
  dkimOrigin: 'EXTERNAL',
  dkimTokens: ['ee'],
  mailFromDomain: 'mail.kindred.com' as string | null,
})

describe('applyIdentityCheck', () => {
  it('keeps verifying while DNS is pending, with the plain reason', () => {
    const next = applyIdentityCheck(check('PENDING', 'PENDING', 'PENDING', 'HOST_NOT_FOUND'), false, now)
    expect(next).toMatchObject({ status: 'PENDING', isVerifying: true, dmarcAdded: false, lastCheckedAt: now })
    expect(next.errorMessage).toMatch(/could not find the DNS records/)
    expect(isSendable(next.status)).toBe(false)
  })

  it('verified but MAIL FROM still pending: sendable, keeps checking', () => {
    const next = applyIdentityCheck(check('SUCCESS', 'SUCCESS', 'PENDING'), true, now)
    expect(next).toMatchObject({ status: 'SUCCESS', mailFromStatus: 'PENDING', isVerifying: true, dmarcAdded: true, errorMessage: null })
    expect(isSendable(next.status)).toBe(true)
  })

  it('everything verified: stops checking', () => {
    expect(applyIdentityCheck(check('SUCCESS'), false, now)).toMatchObject({ status: 'SUCCESS', isVerifying: false })
  })

  it('FAILED (72h without records) stops checking and says how to restart', () => {
    const next = applyIdentityCheck(check('FAILED'), false, now)
    expect(next).toMatchObject({ status: 'FAILED', isVerifying: false })
    expect(next.errorMessage).toMatch(/Re-check/)
  })

  it('an identity Amazon forgot is reported, not silently re-created', () => {
    const next = applyIdentityCheck(NO_DOMAIN_IDENTITY, false, now)
    expect(next).toMatchObject({ status: 'NOT_STARTED', isVerifying: true })
    expect(next.errorMessage).toMatch(/no longer knows this domain/)
  })

  it('names unknown error types instead of hiding them', () => {
    expect(verificationErrorMessage('SOME_NEW_THING', 'PENDING')).toMatch(/some new thing/)
    expect(verificationErrorMessage(null, 'PENDING')).toBeNull()
  })
})

describe('applyIdentityCheck without a MAIL FROM subdomain', () => {
  it('is done once the domain and DKIM verify (Amazon\'s own MAIL FROM needs nothing)', () => {
    const next = applyIdentityCheck({ ...check('SUCCESS', 'SUCCESS', 'NOT_STARTED'), mailFromDomain: null }, false, now)
    expect(next).toMatchObject({ status: 'SUCCESS', isVerifying: false })
  })
})

describe('dueForCheck', () => {
  const created = new Date(now.getTime() - 10 * 60_000)
  it('checks a never-checked domain at once, then every minute in the first hour', () => {
    expect(dueForCheck({ isVerifying: true, lastCheckedAt: null, createdAt: created }, now)).toBe(true)
    expect(dueForCheck({ isVerifying: true, lastCheckedAt: new Date(now.getTime() - 30_000), createdAt: created }, now)).toBe(false)
    expect(dueForCheck({ isVerifying: true, lastCheckedAt: new Date(now.getTime() - 60_000), createdAt: created }, now)).toBe(true)
  })

  it('every ten minutes after the first hour; never once done', () => {
    const old = new Date(now.getTime() - 5 * 3_600_000)
    expect(dueForCheck({ isVerifying: true, lastCheckedAt: new Date(now.getTime() - 5 * 60_000), createdAt: old }, now)).toBe(false)
    expect(dueForCheck({ isVerifying: true, lastCheckedAt: new Date(now.getTime() - 10 * 60_000), createdAt: old }, now)).toBe(true)
    expect(dueForCheck({ isVerifying: false, lastCheckedAt: null, createdAt: old }, now)).toBe(false)
  })
})
