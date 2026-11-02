import Bowser from 'bowser'

/**
 * Settings › Passkeys & sessions: words for one signed-in session (C3b).
 * The device comes from the stored user agent, parsed structurally by
 * bowser (browser + OS names) — never guessed from free text.
 */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  const parsed = Bowser.parse(userAgent)
  const browser = parsed.browser.name?.trim()
  const os = parsed.os.name?.trim()
  if (browser && os) return `${browser} on ${os}`
  return browser || os || null
}

/** The address when recorded; otherwise when the session started (never "Unknown address"). */
export function sessionPlace(
  s: { ipAddress: string | null; createdAt: string },
  formatDay: (iso: string) => string,
): string {
  return s.ipAddress ?? `Signed in ${formatDay(s.createdAt)}`
}
