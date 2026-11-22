import { isIP } from 'node:net'
import { registrableDomainOf } from '$lib/domains/hostname'
import { KernelError } from '$lib/kernel/errors'
import { showsOf, type Shows } from '$lib/server/domains/targets'
import type { EeCertificate, EeStatus } from '$lib/server/ee/client'
import {
  callsRecords,
  claimRecord,
  fromMailRecords,
  normalizeName,
  webRecords,
  type ExpectedRecord,
  type MailRecordInput,
  type ObservedRecord,
} from './dns'

/**
 * The domains view (plan/domains-one-claim.md "The model"): domain → hostnames
 * → what each shows → expected records (computed, structure) → what DNS says
 * → certificate. Composed from the stores that run things, never copied.
 */

/** A mail domain as the email platform keeps it (structural: modules don't import each other). */
export type MailDomain = {
  name: string
  /** Amazon SES verified it: mail can be sent from it. */
  sendable: boolean
  /** Receiving is switched on for it. */
  receiving: boolean
  records: readonly MailRecordInput[]
}

export type HostEmail = { sending: boolean; receiving: boolean }

export type HostView = {
  host: string
  shows: Shows
  /** Email rides along on the same name (A and MX don't clash); null = not a mail domain. */
  email: HostEmail | null
  records: ObservedRecord[]
  /** Managed box: the control plane's claim on this host (its `_ee-verify` TXT is in `records`); null = no claim. */
  claim: { verified: boolean } | null
  /** ee's certificate for the host; null when ee does not serve it. */
  certificate: EeCertificate | null
}

export type DomainView = {
  /** The registrable domain (public suffix list). */
  name: string
  /** Bought through eigenEnterprise (renewal at the control plane) or the company's own DNS. */
  source: 'bought' | 'connected'
  hosts: HostView[]
}

export type DomainsList = {
  /** False when this copy runs without ee: no web hosts, only what the other stores know. */
  managed: boolean
  reason: string | null
  domains: DomainView[]
}

/** A host before its records are looked up. */
export type PlannedHost = Omit<HostView, 'records'> & { expected: ExpectedRecord[] }

/**
 * The address the box's web hosts and calls host must point at: ee's
 * `settings.rtcNodeIp`, the public IP set explicitly at install
 * (`ee bootstrap --node-ip`, never guessed) — the address browsers reach this
 * server on, through a router too. Missing → loud: no record is invented.
 */
export function boxAddress(status: EeStatus): { ip: string; family: 4 | 6 } {
  const raw: unknown = (status.settings as Record<string, unknown>).rtcNodeIp
  const family = typeof raw === 'string' ? isIP(raw) : 0
  if (typeof raw !== 'string' || family === 0) {
    throw new KernelError(
      'not_configured',
      "This server has no public address on record (ee's settings.rtcNodeIp, set with `ee bootstrap --node-ip`), so the DNS records its web addresses need cannot be computed.",
    )
  }
  return { ip: raw, family: family as 4 | 6 }
}

function addressRecords(
  host: string,
  box: { ip: string; family: 4 | 6 },
  purpose: 'web' | 'calls',
): ExpectedRecord[] {
  if (box.family === 6) return [{ name: normalizeName(host), type: 'AAAA', value: box.ip, purpose }]
  return purpose === 'web'
    ? webRecords({ host, ipv4: box.ip, ipv6: null })
    : callsRecords({ host, ipv4: box.ip })
}

/** Every host the company uses, with what it shows, its email, its expected records and its certificate. */
export function planHosts(input: {
  status: EeStatus | null
  mail: readonly MailDomain[]
}): PlannedHost[] {
  const { status } = input
  const hosts = new Set<string>()
  if (status) {
    const s = status.settings
    for (const h of [
      s.consoleHost,
      s.publicHost,
      s.callsHost,
      ...status.routes.map((r) => r.host),
    ]) {
      if (h) hosts.add(h)
    }
    // A claimed host shows up even before it is routed (it waits on its TXT).
    for (const c of status.claims ?? []) hosts.add(c.host)
  }
  const mailByName = new Map(input.mail.map((d) => [normalizeName(d.name), d]))
  for (const name of mailByName.keys()) hosts.add(name)

  let box: { ip: string; family: 4 | 6 } | null = null
  const address = (s: EeStatus) => (box ??= boxAddress(s))

  return [...hosts].sort().map((host): PlannedHost => {
    const shows: Shows = status ? showsOf(status, host) : { kind: 'nothing' }
    const mail = mailByName.get(host) ?? null
    const expected: ExpectedRecord[] = []
    if (status && shows.kind === 'calls')
      expected.push(...addressRecords(host, address(status), 'calls'))
    else if (status && shows.kind !== 'nothing')
      expected.push(...addressRecords(host, address(status), 'web'))
    const claim = status?.claims?.find((c) => c.host === host) ?? null
    if (claim) expected.push(claimRecord({ host, token: claim.txtValue }))
    if (mail) expected.push(...fromMailRecords(mail.records))
    return {
      host,
      shows,
      email: mail ? { sending: mail.sendable, receiving: mail.receiving } : null,
      claim: claim ? { verified: claim.verified } : null,
      expected,
      certificate: status?.certificates?.find((c) => c.host === host) ?? null,
    }
  })
}

/** The registrable domain a host belongs to; a name without one (no public suffix) stands alone. */
export function domainOf(host: string): string {
  return registrableDomainOf(host) ?? host
}

/** Hosts grouped into their domains (apex first), bought domains included even before anything uses them. */
export function groupDomains(hosts: readonly HostView[], bought: readonly string[]): DomainView[] {
  const boughtSet = new Set(bought.map(normalizeName))
  const byDomain = new Map<string, HostView[]>()
  for (const name of boughtSet) byDomain.set(name, [])
  for (const h of hosts) {
    const name = domainOf(h.host)
    byDomain.set(name, [...(byDomain.get(name) ?? []), h])
  }
  return [...byDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({
      name,
      source: boughtSet.has(name) ? ('bought' as const) : ('connected' as const),
      hosts: [...list].sort((a, b) =>
        a.host === name ? -1 : b.host === name ? 1 : a.host.localeCompare(b.host),
      ),
    }))
}
