import { X509Certificate } from 'node:crypto'
import { z } from 'zod'
import { isReservedHost } from './caddy.ts'
import { PATHS } from './paths.ts'
import type { Route } from './spec.ts'
import type { System } from './system.ts'

/**
 * Certificate status per host ee serves (plan/domains-one-claim.md D1).
 *
 * Two observed sources, nothing guessed:
 * - Caddy's certificate storage (pinned by ee in the rendered config, caddy.ts):
 *   the stored leaf's notAfter says whether a certificate is issued.
 * - Caddy's structured JSON log in the journal (certmagic's tls.obtain / tls.renew
 *   loggers): the last attempt's error and, when attributable, its next retry.
 *   Only fixed message constants and JSON fields are read; free text is shown as is.
 */

export type CertificateState = 'issued' | 'pending' | 'failing'
export type CertificateStatus = {
  host: string
  state: CertificateState
  /** Caddy's own error text for the last failed attempt since the last success (or why ee could not tell). */
  lastError: string | null
  /** When Caddy retries next (its "will retry" retrying_in); null when unknown or not waiting. */
  nextRetryAt: string | null
  /** The stored certificate's notAfter (even when expired); null when none is stored. */
  notAfter: string | null
}

/** certmagic's issuer key for the ACME issuer with its default CA (Let's Encrypt production): the directory URL, scheme stripped, `/` → `-`. */
export const ACME_ISSUER_KEY = 'acme-v02.api.letsencrypt.org-directory'
/** certmagic's issuer key for Caddy's internal CA (reserved names, caddy.ts). */
export const LOCAL_ISSUER_KEY = 'local'
/** How many of Caddy's most recent journal lines are read. Older attempts are not seen. */
export const CADDY_LOG_LINES = 5000

/** The leaf Caddy stores for a single-name certificate: certificates/<issuer key>/<host>/<host>.crt. */
export function certificatePath(host: string): string {
  const issuer = isReservedHost(host) ? LOCAL_ISSUER_KEY : ACME_ISSUER_KEY
  return `${PATHS.caddyStorage}/certificates/${issuer}/${host}/${host}.crt`
}

/** Every host ee serves: the console host, the calls host, then each route's host (once each). */
export function servedHosts(settings: { consoleHost: string; callsHost: string | null }, routes: Route[]): string[] {
  const hosts = [settings.consoleHost, ...(settings.callsHost ? [settings.callsHost] : []), ...routes.map((r) => r.host)]
  return [...new Set(hosts)]
}

export type ObservedAttempt = {
  /** trying: an attempt started after the last outcome; failed / obtained: the last outcome. */
  outcome: 'trying' | 'failed' | 'obtained'
  lastError: string | null
  nextRetryAt: string | null
}

const OBTAIN_LOGGERS = new Set(['tls.obtain', 'tls.renew'])
const STARTED = new Set(['obtaining certificate', 'renewing certificate'])
const SUCCEEDED = new Set(['certificate obtained successfully', 'certificate renewed successfully'])
const FAILED = 'could not get certificate from issuer'
const WILL_RETRY = 'will retry'
const GAVE_UP = 'final attempt; giving up'

const entrySchema = z.object({
  ts: z.number(),
  logger: z.string(),
  msg: z.string(),
  identifier: z.string().optional(),
  error: z.string().optional(),
  /** zap's default duration encoding: seconds. */
  retrying_in: z.number().optional(),
})

/**
 * Read certmagic's obtain/renew lines in order. "will retry" / "final attempt"
 * carry no identifier: they are attributed to the one host whose failure on the
 * same logger is still waiting for them; when several are waiting (two hosts
 * failing at once), none is attributed and their next retry stays unknown.
 */
export function observeCaddyLog(lines: string[]): Map<string, ObservedAttempt> {
  const seen = new Map<string, ObservedAttempt>()
  /** host → logger of a failure whose retry line has not been read yet. */
  const waiting = new Map<string, string>()
  for (const raw of lines) {
    if (!raw.startsWith('{')) continue
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      continue
    }
    const parsed = entrySchema.safeParse(json)
    if (!parsed.success || !OBTAIN_LOGGERS.has(parsed.data.logger)) continue
    const e = parsed.data
    const at = (host: string) => seen.get(host) ?? { outcome: 'trying' as const, lastError: null, nextRetryAt: null }
    if (e.identifier && STARTED.has(e.msg)) {
      seen.set(e.identifier, { ...at(e.identifier), outcome: 'trying', nextRetryAt: null })
      waiting.delete(e.identifier)
    } else if (e.identifier && SUCCEEDED.has(e.msg)) {
      seen.set(e.identifier, { outcome: 'obtained', lastError: null, nextRetryAt: null })
      waiting.delete(e.identifier)
    } else if (e.identifier && e.msg === FAILED) {
      seen.set(e.identifier, { outcome: 'failed', lastError: e.error ?? null, nextRetryAt: null })
      waiting.set(e.identifier, e.logger)
    } else if (e.msg === WILL_RETRY || e.msg === GAVE_UP) {
      const candidates = [...waiting].filter(([, logger]) => logger === e.logger).map(([host]) => host)
      for (const host of candidates) waiting.delete(host)
      if (candidates.length === 1 && e.msg === WILL_RETRY && e.retrying_in !== undefined) {
        const host = candidates[0]!
        seen.set(host, { ...at(host), nextRetryAt: new Date((e.ts + e.retrying_in) * 1000).toISOString() })
      }
    }
  }
  return seen
}

type Stored = { notAfter: string } | { error: string } | null

async function storedCertificate(sys: System, host: string): Promise<Stored> {
  const path = certificatePath(host)
  const pem = await sys.readFile(path)
  if (pem === null) return null
  try {
    const notAfter = new Date(new X509Certificate(pem).validTo)
    if (Number.isNaN(notAfter.getTime())) throw new Error('its notAfter is not a date')
    return { notAfter: notAfter.toISOString() }
  } catch (err) {
    return { error: `the stored certificate ${path} could not be read: ${(err as Error).message}` }
  }
}

/** Certificate status for each host, in the given order. */
export async function readCertificates(sys: System, hosts: string[]): Promise<CertificateStatus[]> {
  const log = await sys.run('journalctl', ['-u', 'caddy.service', '-o', 'cat', '--no-pager', '-n', String(CADDY_LOG_LINES)])
  const logError = log.code === 0 ? null : `Caddy's log could not be read: ${(log.stderr || log.stdout).trim() || `journalctl exited ${log.code}`}`
  const seen = logError ? new Map<string, ObservedAttempt>() : observeCaddyLog(log.stdout.split('\n'))
  const now = sys.now().getTime()
  const out: CertificateStatus[] = []
  for (const host of hosts) {
    const stored = await storedCertificate(sys, host)
    if (stored && 'error' in stored) {
      out.push({ host, state: 'failing', lastError: stored.error, nextRetryAt: null, notAfter: null })
      continue
    }
    const attempt = seen.get(host)
    const notAfter = stored?.notAfter ?? null
    const lastError = attempt?.lastError ?? null
    const nextRetryAt = attempt?.nextRetryAt ?? null
    if (notAfter !== null && Date.parse(notAfter) > now) {
      out.push({ host, state: 'issued', lastError, nextRetryAt, notAfter })
    } else if (attempt?.outcome === 'failed') {
      out.push({ host, state: 'failing', lastError, nextRetryAt, notAfter })
    } else {
      out.push({ host, state: 'pending', lastError: logError ?? lastError, nextRetryAt, notAfter })
    }
  }
  return out
}
