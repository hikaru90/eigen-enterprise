import type { ObservedRecord } from '../../../modules/domains/dns'
import type { HostView } from '../../../modules/domains/view'
import type { Shows, ShowsTarget } from '$lib/server/domains/targets'

/**
 * How a hostname stands, for every page that shows one (Settings › Domains,
 * the company website, an app, Email): structure over `domains.list`'s host
 * view, no model. Isomorphic (types only from the server side).
 */

export type { HostView, ObservedRecord, Shows, ShowsTarget }

/** The records a person has to add or change: missing or wrong (a failed lookup is not a fix). */
export function recordsToFix(records: readonly ObservedRecord[]): ObservedRecord[] {
  return records.filter((r) => r.status === 'missing' || r.status === 'wrong')
}

export type Tone = 'ok' | 'waiting' | 'failing'

/** The host's state in the order it fails in practice: DNS → claim → certificate. */
export function hostReadiness(h: HostView): { tone: Tone; label: string } {
  const toFix = recordsToFix(h.records).length
  if (toFix > 0) return { tone: 'waiting', label: `DNS: ${toFix} to fix` }
  if (h.records.some((r) => r.status === 'lookup_failed'))
    return { tone: 'waiting', label: 'DNS could not be checked' }
  if (h.claim && !h.claim.verified) return { tone: 'waiting', label: 'Waiting for the TXT record' }
  if (h.certificate?.state === 'failing') return { tone: 'failing', label: 'Certificate failing' }
  if (h.certificate?.state === 'pending') return { tone: 'waiting', label: 'Certificate pending' }
  return { tone: 'ok', label: h.shows.kind === 'nothing' ? 'DNS ok' : 'Live' }
}

/** The DNS column: "All ok", "2 to fix", or the lookups that failed. */
export function dnsSummary(records: readonly ObservedRecord[]): { tone: Tone; label: string } {
  if (records.length === 0) return { tone: 'ok', label: 'Nothing needed' }
  const toFix = recordsToFix(records).length
  if (toFix > 0) return { tone: 'waiting', label: `${toFix} to fix` }
  const failed = records.filter((r) => r.status === 'lookup_failed').length
  if (failed > 0) return { tone: 'waiting', label: `${failed} could not be checked` }
  return { tone: 'ok', label: 'All ok' }
}

/** In a picker or a cell: "Console", "Company website", "App shop", "Calls", "Nothing". */
export function showsLabel(s: Shows): string {
  switch (s.kind) {
    case 'console':
      return 'Console'
    case 'site':
      return 'Company website'
    case 'app':
      return `App ${s.app}`
    case 'calls':
      return 'Calls'
    case 'nothing':
      return 'Nothing'
  }
}

/** A target as one form value: console, site, nothing, app:<name>. */
export function encodeShows(s: ShowsTarget): string {
  return s.kind === 'app' ? `app:${s.app}` : s.kind
}

/** The form value back as a target; null when it is none of them (the tool's schema checks the app name). */
export function decodeShows(value: string): ShowsTarget | null {
  if (value === 'console' || value === 'site' || value === 'nothing') return { kind: value }
  if (value.startsWith('app:') && value.length > 4) return { kind: 'app', app: value.slice(4) }
  return null
}

/** The picker's choices: the console, the company website, each app, nothing. */
export function targetChoices(apps: readonly string[]): ShowsTarget[] {
  return [
    { kind: 'console' },
    { kind: 'site' },
    ...apps.map((app) => ({ kind: 'app' as const, app })),
    { kind: 'nothing' },
  ]
}

/** A module page's address: the hostname, its readiness label, live or not. */
export type Address = { host: string; label: string; on: boolean }
