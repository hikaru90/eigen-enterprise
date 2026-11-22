import type { DnsResolver } from './observe'
import { normalizeName } from './records'

export type CachedResolver = DnsResolver & {
  /** Drop every cached answer for this name ("Check now"). */
  forget(name: string): void
}

type Entry = { at: number; answer: Promise<unknown> }

/**
 * Memoises each (name, type) lookup for ttlMs, failures included (the same
 * answer until the TTL passes or `forget(name)`). Concurrent callers share
 * one in-flight lookup.
 */
export function cachedResolver(
  resolver: DnsResolver,
  ttlMs: number,
  now: () => number,
): CachedResolver {
  if (!(ttlMs > 0)) throw new Error(`cachedResolver needs a positive ttl in ms; got ${ttlMs}.`)
  const entries = new Map<string, Map<string, Entry>>()

  const cached = <T>(type: string, name: string, run: (n: string) => Promise<T>): Promise<T> => {
    const key = normalizeName(name)
    let byType = entries.get(key)
    if (!byType) {
      byType = new Map()
      entries.set(key, byType)
    }
    const hit = byType.get(type)
    const t = now()
    if (hit && t - hit.at < ttlMs) return hit.answer as Promise<T>
    const answer = run(name)
    // Keep the rejection for later callers without leaving it unhandled here.
    answer.catch(() => {})
    byType.set(type, { at: t, answer })
    return answer
  }

  return {
    resolve4: (n) => cached('A', n, (x) => resolver.resolve4(x)),
    resolve6: (n) => cached('AAAA', n, (x) => resolver.resolve6(x)),
    resolveCname: (n) => cached('CNAME', n, (x) => resolver.resolveCname(x)),
    resolveTxt: (n) => cached('TXT', n, (x) => resolver.resolveTxt(x)),
    resolveMx: (n) => cached('MX', n, (x) => resolver.resolveMx(x)),
    forget: (name) => {
      entries.delete(normalizeName(name))
    },
  }
}
