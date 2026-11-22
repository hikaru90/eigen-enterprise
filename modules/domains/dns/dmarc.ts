/**
 * DMARC records (RFC 7489 §6.3/§6.4) parsed as the protocol defines them:
 * `tag=value` pairs separated by `;`, `v=DMARC1` first, a `p` policy. This is
 * parsing a protocol, not a heuristic: the expected DMARC record
 * (`v=DMARC1; p=none;`) is a minimum, and a company that already publishes a
 * stricter policy (`p=quarantine` / `p=reject`) has a valid DMARC record —
 * comparing the exact text would call it "wrong".
 */

/** The expected-record purpose of the email module's DMARC record (`mail_` + its `dmarc` purpose). */
export const DMARC_PURPOSE = 'mail_dmarc'

export type DmarcPolicy = 'none' | 'quarantine' | 'reject'

const POLICIES: ReadonlySet<string> = new Set<DmarcPolicy>(['none', 'quarantine', 'reject'])

/** Whitespace as RFC 7489's ABNF allows it around tags and values (WSP, and folding CRLF). */
const trimWsp = (s: string) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')

/**
 * The record's tags, or null when it is not a DMARC record: the first tag must
 * be `v` with the value `DMARC1` (case-sensitive, §6.4), every part a
 * `tag=value` pair, no tag twice. Tag names are case-insensitive.
 */
export function parseDmarcTags(txt: string): Map<string, string> | null {
  const parts = txt.split(';').map(trimWsp)
  // A trailing ";" leaves one empty part at the end; empty parts elsewhere are malformed.
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  const tags = new Map<string, string>()
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) return null
    const tag = trimWsp(part.slice(0, eq)).toLowerCase()
    const value = trimWsp(part.slice(eq + 1))
    if (!/^[a-z0-9]+$/.test(tag) || tags.has(tag)) return null
    tags.set(tag, value)
  }
  const [first] = tags.entries()
  if (!first || first[0] !== 'v' || first[1] !== 'DMARC1') return null
  return tags
}

/** The record's policy (`p`), or null when it is not a valid DMARC record with one. */
export function dmarcPolicy(txt: string): DmarcPolicy | null {
  const p = parseDmarcTags(txt)?.get('p')?.toLowerCase()
  return p !== undefined && POLICIES.has(p) ? (p as DmarcPolicy) : null
}

/** Whether `txt` starts a DMARC record at all (`v=DMARC1` first) — RFC 7489 §6.6.3 discards the rest. */
export function isDmarcRecord(txt: string): boolean {
  return /^v[ \t]*=[ \t]*DMARC1[ \t]*(;|$)/.test(trimWsp(txt))
}

/**
 * Whether the TXT answers at `_dmarc.<domain>` hold a valid DMARC policy:
 * exactly one DMARC record (§6.6.3: more than one means none applies), with a
 * `p` of none, quarantine or reject.
 */
export function dmarcSatisfied(answers: readonly string[]): boolean {
  const dmarc = answers.filter(isDmarcRecord)
  return dmarc.length === 1 && dmarcPolicy(dmarc[0]!) !== null
}
