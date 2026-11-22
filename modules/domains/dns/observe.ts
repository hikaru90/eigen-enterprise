import type { ExpectedRecord, ObservedRecord, RecordType } from './records'
import { Resolver } from 'node:dns/promises'
import { DMARC_PURPOSE, dmarcSatisfied } from './dmarc'

/** The lookups the observer needs; `node:dns/promises` Resolver in the app, a fake in tests. */
export type DnsResolver = {
  resolve4(name: string): Promise<string[]>
  resolve6(name: string): Promise<string[]>
  resolveCname(name: string): Promise<string[]>
  resolveTxt(name: string): Promise<string[][]>
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>
}

/** A resolver over the system's DNS servers. */
export function nodeResolver(): DnsResolver {
  const r = new Resolver()
  return {
    resolve4: (name) => r.resolve4(name),
    resolve6: (name) => r.resolve6(name),
    resolveCname: (name) => r.resolveCname(name),
    resolveTxt: (name) => r.resolveTxt(name),
    resolveMx: (name) => r.resolveMx(name),
  }
}

/** node:dns codes for "the name has no such records" (NXDOMAIN / no data), as opposed to a failed lookup. */
const NO_RECORDS = new Set(['ENODATA', 'ENOTFOUND'])

const dnsCode = (err: unknown): string | null =>
  err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : null

type MxAnswer = { exchange: string; priority: number }

/** One lookup's answer, kept raw enough for every record that shares (name, type). */
type Answer =
  | { kind: 'values'; type: 'A' | 'AAAA' | 'CNAME'; values: string[] }
  | { kind: 'txt'; values: string[] }
  | { kind: 'mx'; values: MxAnswer[] }
  | { kind: 'none' }
  | { kind: 'failed'; error: string }

async function lookup(resolver: DnsResolver, name: string, type: RecordType): Promise<Answer> {
  try {
    switch (type) {
      case 'A':
        return { kind: 'values', type, values: await resolver.resolve4(name) }
      case 'AAAA':
        return { kind: 'values', type, values: await resolver.resolve6(name) }
      case 'CNAME':
        return { kind: 'values', type, values: await resolver.resolveCname(name) }
      case 'TXT':
        return {
          kind: 'txt',
          values: (await resolver.resolveTxt(name)).map((chunks) => chunks.join('')),
        }
      case 'MX':
        return { kind: 'mx', values: await resolver.resolveMx(name) }
    }
  } catch (err) {
    const code = dnsCode(err)
    if (code !== null && NO_RECORDS.has(code)) return { kind: 'none' }
    return { kind: 'failed', error: code ?? (err instanceof Error ? err.message : String(err)) }
  }
}

/** Hostnames compare case-insensitively without the trailing dot. */
const hostKey = (h: string) => h.trim().toLowerCase().replace(/\.$/, '')

/** IPv6 in canonical (compressed, lowercase) form; the WHATWG URL parser does exactly this. */
function ipv6Key(addr: string): string {
  try {
    return new URL(`http://[${addr.trim()}]/`).hostname.slice(1, -1)
  } catch {
    return addr.trim().toLowerCase()
  }
}

function judge(record: ExpectedRecord, answer: Answer): ObservedRecord {
  switch (answer.kind) {
    case 'failed':
      return { ...record, status: 'lookup_failed', observed: [], error: answer.error }
    case 'none':
      return { ...record, status: 'missing', observed: [], error: null }
    case 'values':
    case 'txt': {
      const observed = answer.values
      if (observed.length === 0) return { ...record, status: 'missing', observed, error: null }
      if (answer.kind === 'txt' && record.purpose === DMARC_PURPOSE) {
        // The expected `p=none` is a minimum: any valid policy the company has is ok (RFC 7489).
        const ok = dmarcSatisfied(observed)
        return { ...record, status: ok ? 'ok' : 'wrong', observed, error: null }
      }
      const key =
        answer.kind === 'txt'
          ? (v: string) => v
          : answer.type === 'CNAME'
            ? hostKey
            : answer.type === 'AAAA'
              ? ipv6Key
              : (v: string) => v.trim()
      const ok = observed.some((v) => key(v) === key(record.value))
      return { ...record, status: ok ? 'ok' : 'wrong', observed, error: null }
    }
    case 'mx': {
      const observed = answer.values.map((m) => `${m.priority} ${m.exchange}`)
      if (observed.length === 0) return { ...record, status: 'missing', observed, error: null }
      const ok = answer.values.some(
        (m) =>
          hostKey(m.exchange) === hostKey(record.value) &&
          (record.priority === undefined || m.priority === record.priority),
      )
      return { ...record, status: ok ? 'ok' : 'wrong', observed, error: null }
    }
  }
}

/**
 * Whether live DNS has each expected record. One lookup per (name, type),
 * shared by every record that needs it; results keep the input order.
 */
export async function observe(
  expected: readonly ExpectedRecord[],
  resolver: DnsResolver,
): Promise<ObservedRecord[]> {
  const lookups = new Map<string, Promise<Answer>>()
  const answerFor = (r: ExpectedRecord) => {
    const key = `${r.type} ${r.name}`
    let p = lookups.get(key)
    if (!p) {
      p = lookup(resolver, r.name, r.type)
      lookups.set(key, p)
    }
    return p
  }
  return Promise.all(expected.map(async (r) => judge(r, await answerFor(r))))
}
