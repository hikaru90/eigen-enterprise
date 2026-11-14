import type { DomainIdentityInfo } from '../owlery/ses'

/**
 * The domain verification state machine (ported from Owlery's
 * refreshDomainVerification): one SES identity read + one DMARC lookup in, the
 * next stored state out. Pure, so every transition is unit-tested.
 *
 *   NOT_STARTED/PENDING ──DNS found──▶ SUCCESS (ready to send)
 *         │                              │ (keeps checking until DKIM and MAIL FROM are SUCCESS too)
 *         └──72h without records──▶ FAILED (stops checking; "Re-check" restarts)
 */

export type DomainVerificationState = {
  status: string
  dkimStatus: string
  mailFromStatus: string
  dmarcAdded: boolean
  isVerifying: boolean
  errorMessage: string | null
  lastCheckedAt: Date | null
}

const ERROR_COPY: Record<string, string> = {
  HOST_NOT_FOUND: 'Amazon could not find the DNS records yet. Add them at your DNS provider; changes can take up to a few hours to appear.',
  INVALID_VALUE: 'A DNS record has the wrong value. Copy it again exactly as shown (no quotes or spaces added).',
  DNS_SERVER_ERROR: 'Your DNS provider did not answer Amazon. This is usually temporary — ee keeps checking.',
  TYPE_NOT_FOUND: 'A DNS record has the wrong type. The DKIM and SPF records are TXT, the mail record is MX.',
  SERVICE_ERROR: 'Amazon had a problem checking the domain. ee keeps checking.',
}

/** The plain-language reason for an SES verification error type. */
export function verificationErrorMessage(errorType: string | null, status: string): string | null {
  if (errorType) return ERROR_COPY[errorType] ?? `Amazon reported: ${errorType.replace(/_/g, ' ').toLowerCase()}.`
  if (status === 'FAILED') {
    return 'Amazon stopped looking for the DNS records (they were not found within 72 hours). Add them, then press Re-check.'
  }
  return null
}

/** Ready to send: SES verified the domain. DKIM and MAIL FROM may still be finishing. */
export function isSendable(status: string): boolean {
  return status === 'SUCCESS'
}

export function applyIdentityCheck(
  check: DomainIdentityInfo,
  dmarcFound: boolean,
  now: Date,
): DomainVerificationState {
  const status = check.exists ? check.verification : 'NOT_STARTED'
  // Without a MAIL FROM subdomain Amazon uses its own: nothing to wait for there.
  const mailFromDone = check.mailFromDomain === null || check.mailFrom === 'SUCCESS'
  const done = status === 'SUCCESS' && check.dkim === 'SUCCESS' && mailFromDone
  return {
    status,
    dkimStatus: check.dkim,
    mailFromStatus: check.mailFrom,
    dmarcAdded: dmarcFound,
    // FAILED stops the background checks; a manual re-check starts them again.
    isVerifying: !done && status !== 'FAILED',
    errorMessage: check.exists
      ? verificationErrorMessage(check.errorType, status)
      : 'Amazon no longer knows this domain. Remove it here and add it again.',
    lastCheckedAt: now,
  }
}

/** Background re-check cadence: every minute in the first hour after adding, then every 10 minutes. */
export function dueForCheck(
  d: { isVerifying: boolean; lastCheckedAt: Date | null; createdAt: Date },
  now: Date,
): boolean {
  if (!d.isVerifying) return false
  if (!d.lastCheckedAt) return true
  const age = now.getTime() - d.createdAt.getTime()
  const interval = age < 3_600_000 ? 60_000 : 600_000
  return now.getTime() - d.lastCheckedAt.getTime() >= interval
}
