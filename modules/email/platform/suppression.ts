/**
 * Suppression rules (ported from Owlery's suppression-service): addresses are
 * compared trimmed + lowercased, and a suppressed recipient is never mailed —
 * the send is logged as "suppressed" instead.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Splits recipients into the ones that may be mailed and the suppressed ones (input order kept). */
export function partitionSuppressed(
  recipients: string[],
  suppressed: ReadonlySet<string>,
): { allowed: string[]; suppressed: string[] } {
  const allowed: string[] = []
  const blocked: string[] = []
  for (const r of recipients) (suppressed.has(normalizeEmail(r)) ? blocked : allowed).push(r)
  return { allowed, suppressed: blocked }
}

export const SUPPRESSION_REASON_LABEL: Record<string, string> = {
  HARD_BOUNCE: 'Bounced (address does not exist)',
  COMPLAINT: 'Marked as spam',
  MANUAL: 'Added by hand',
}
