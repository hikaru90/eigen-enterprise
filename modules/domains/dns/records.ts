/**
 * The DNS records a hostname needs, computed from what it is used for
 * (structure, no model): web → A/AAAA to the box, managed claim → the
 * control plane's `_ee-verify.<host>` TXT, calls → A, mail → the email
 * module's own `dnsRecords()` mapped in through `fromMailRecords`.
 */

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX'

export type ExpectedRecord = {
  /** Lowercase FQDN without trailing dot. */
  name: string
  type: RecordType
  value: string
  /** MX only; when absent the priority is not compared. */
  priority?: number
  /** What the record is for: web, claim, calls, mail_<email purpose>. */
  purpose: string
}

export type ObservedStatus = 'ok' | 'missing' | 'wrong' | 'lookup_failed'

export type ObservedRecord = ExpectedRecord & {
  status: ObservedStatus
  /** What live DNS returned for (name, type), as display strings ("10 mx.example.com" for MX). */
  observed: string[]
  /** The resolver's error code (or message) when status is lookup_failed; otherwise null. */
  error: string | null
}

/** Lowercase, no trailing dot; empty is refused. */
export function normalizeName(host: string): string {
  const name = host.trim().toLowerCase().replace(/\.$/, '')
  if (!name) throw new Error('A DNS record needs a host name; got an empty one.')
  return name
}

function required(value: string, what: string): string {
  if (!value.trim()) throw new Error(`A DNS record needs ${what}; got an empty one.`)
  return value.trim()
}

/** A (and AAAA when the box has public IPv6) on the host, pointing at the box. */
export function webRecords(input: {
  host: string
  ipv4: string
  ipv6: string | null
}): ExpectedRecord[] {
  const name = normalizeName(input.host)
  const records: ExpectedRecord[] = [
    { name, type: 'A', value: required(input.ipv4, 'an IPv4 address'), purpose: 'web' },
  ]
  if (input.ipv6 !== null) {
    records.push({
      name,
      type: 'AAAA',
      value: required(input.ipv6, 'an IPv6 address'),
      purpose: 'web',
    })
  }
  return records
}

/** Managed boxes: the `_ee-verify.<host>` TXT = the company's token, exactly what the control plane verifies. */
export function claimRecord(input: { host: string; token: string }): ExpectedRecord {
  return {
    name: `_ee-verify.${normalizeName(input.host)}`,
    type: 'TXT',
    value: required(input.token, 'a claim token'),
    purpose: 'claim',
  }
}

/** Calls (rtc.<host>): an A record pointing at the box. */
export function callsRecords(input: { host: string; ipv4: string }): ExpectedRecord[] {
  return [
    {
      name: normalizeName(input.host),
      type: 'A',
      value: required(input.ipv4, 'an IPv4 address'),
      purpose: 'calls',
    },
  ]
}

/**
 * The fields of `modules/email/platform/dns.ts` `DnsRecord` this adapter reads.
 * Declared structurally (modules don't import each other); `dnsRecords()` output
 * is assignable as is.
 */
export type MailRecordInput = {
  purpose: string
  type: 'MX' | 'TXT' | 'CNAME'
  name: string
  /** Null only for a DKIM key the owner published outside ee. */
  value: string | null
  priority: number | null
}

/**
 * Mail records as expected records. A record whose value ee does not know (a
 * DKIM key published outside ee; Amazon never shows its public half) has
 * nothing to compare against and is left out; its status stays the email
 * module's (SES verification).
 */
export function fromMailRecords(records: readonly MailRecordInput[]): ExpectedRecord[] {
  const out: ExpectedRecord[] = []
  for (const r of records) {
    if (r.value === null) continue
    const record: ExpectedRecord = {
      name: normalizeName(r.name),
      type: r.type,
      value: r.value,
      purpose: `mail_${r.purpose}`,
    }
    if (r.type === 'MX' && r.priority !== null) record.priority = r.priority
    out.push(record)
  }
  return out
}
