import { CORE_SCHEMA, dump, load } from 'js-yaml'

/**
 * Canonical file formats for the company data repo (plan/phase-git-native.md
 * §1.6): the same value always serializes to the same bytes, so diffs stay
 * small and merges sane.
 *
 * - Objects: keys sorted (code-unit order), recursively. Arrays keep their order
 *   (order is data — a surface that wants a set sorts before writing).
 * - Dates become ISO-8601 UTC strings. `undefined` keys are dropped; `undefined`
 *   in arrays, functions, symbols, bigint and non-finite numbers are refused.
 * - Text always uses `\n` and ends with exactly one newline.
 * - YAML uses the YAML 1.2 core schema both ways (no implicit timestamps), block
 *   style, no line folding, no anchors.
 */

export type Canonical =
  null | boolean | number | string | Canonical[] | { [key: string]: Canonical }

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalError'
  }
}

export function canonicalize(value: unknown, at = '$'): Canonical {
  if (value === null) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new CanonicalError(`${at}: invalid date`)
    return value.toISOString()
  }
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalError(`${at}: non-finite number`)
      return Object.is(value, -0) ? 0 : value
    case 'object': {
      if (Array.isArray(value)) {
        return value.map((v, i) => {
          if (v === undefined) throw new CanonicalError(`${at}[${i}]: undefined in array`)
          return canonicalize(v, `${at}[${i}]`)
        })
      }
      const out: { [key: string]: Canonical } = {}
      for (const key of Object.keys(value as object).sort()) {
        const v = (value as Record<string, unknown>)[key]
        if (v === undefined) continue
        out[key] = canonicalize(v, `${at}.${key}`)
      }
      return out
    }
    default:
      throw new CanonicalError(`${at}: ${typeof value} is not serializable`)
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Pretty JSON, 2-space indent, sorted keys, trailing newline. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

export function canonicalYaml(value: unknown): string {
  return dump(canonicalize(value), {
    schema: CORE_SCHEMA,
    sortKeys: true,
    lineWidth: -1,
    noRefs: true,
    indent: 2,
  })
}

export function parseYaml(text: string): unknown {
  return load(normalizeText(text), { schema: CORE_SCHEMA })
}

export type MarkdownDoc = { frontmatter: Record<string, unknown>; body: string }

/** `---\n<canonical yaml>---\n\n<body>\n` — empty frontmatter omits the fence. */
export function canonicalMarkdown(doc: MarkdownDoc): string {
  const body = normalizeText(doc.body).replace(/^\n+/, '').trimEnd()
  const fm = canonicalize(doc.frontmatter)
  const hasFm = fm !== null && typeof fm === 'object' && Object.keys(fm).length > 0
  const head = hasFm ? `---\n${canonicalYaml(fm)}---\n` : ''
  if (body.length === 0) return head.length > 0 ? head : '\n'
  return hasFm ? `${head}\n${body}\n` : `${body}\n`
}

export function parseMarkdown(text: string): MarkdownDoc {
  const t = normalizeText(text)
  if (!t.startsWith('---\n')) return { frontmatter: {}, body: t.trim() }
  const end = t.indexOf('\n---\n', 3)
  if (end < 0) throw new CanonicalError('markdown frontmatter is not closed with ---')
  const fm = parseYaml(t.slice(4, end + 1))
  if (fm !== null && fm !== undefined && (typeof fm !== 'object' || Array.isArray(fm))) {
    throw new CanonicalError('markdown frontmatter must be a mapping')
  }
  return { frontmatter: (fm ?? {}) as Record<string, unknown>, body: t.slice(end + 5).trim() }
}

/** One JSONL record: compact canonical JSON + `\n`. */
export function jsonlLine(record: unknown): string {
  const c = canonicalize(record)
  if (c === null || typeof c !== 'object' || Array.isArray(c))
    throw new CanonicalError('a JSONL record must be an object')
  return `${JSON.stringify(c)}\n`
}

/** Append-only: existing bytes are never rewritten, only extended. */
export function appendJsonl(existing: string, records: readonly unknown[]): string {
  if (existing.length > 0 && !existing.endsWith('\n'))
    throw new CanonicalError('JSONL file does not end with a newline')
  return existing + records.map(jsonlLine).join('')
}

export function parseJsonl(text: string): unknown[] {
  return normalizeText(text)
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as unknown
      } catch (err) {
        throw new CanonicalError(`JSONL line ${i + 1} is not valid JSON: ${(err as Error).message}`)
      }
    })
}
