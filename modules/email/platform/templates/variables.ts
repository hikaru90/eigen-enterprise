/**
 * `{{variable}}` placeholders for templates and layouts (Owlery's
 * replaceVariables, made strict): values are HTML-escaped in the body, a
 * placeholder may carry a fallback (`{{ firstName | "there" }}`), and a
 * placeholder with neither a value nor a fallback is reported as missing —
 * a send never goes out with a silent blank. `brand.*` names are the active
 * brand's tokens; `content` is a layout's slot. Shared by server and editor.
 */

/** {{ name }} or {{ name | "fallback" }} — names are letters, digits, _ and dots. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|\s*"((?:[^"\\]|\\.)*)"\s*)?\}\}/g

/** The layout slot a template's body goes into. */
export const CONTENT_SLOT = 'content'

export type Placeholder = { name: string; fallback: string | null }

export function placeholders(source: string): Placeholder[] {
  const out: Placeholder[] = []
  for (const m of source.matchAll(PLACEHOLDER)) {
    out.push({ name: m[1]!, fallback: m[2] === undefined ? null : m[2].replace(/\\(.)/g, '$1') })
  }
  return out
}

/** The variables a caller must (or may) pass: everything but brand tokens and the layout slot, unique, in order. */
export function templateVariables(...sources: string[]): { name: string; required: boolean }[] {
  const seen = new Map<string, boolean>()
  for (const src of sources) {
    for (const p of placeholders(src)) {
      if (p.name === CONTENT_SLOT || p.name.startsWith('brand.')) continue
      seen.set(p.name, (seen.get(p.name) ?? false) || p.fallback === null)
    }
  }
  return [...seen].map(([name, required]) => ({ name, required }))
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export type SubstituteResult = { output: string; missing: string[] }

/**
 * Replaces every placeholder. `escape` is on for html/mjml bodies, off for the
 * subject and the plain-text body. `keep` names stay untouched (the layout slot).
 */
export function substitute(
  source: string,
  values: Record<string, string>,
  opts: { escape: boolean; keep?: readonly string[] },
): SubstituteResult {
  const missing = new Set<string>()
  const output = source.replace(PLACEHOLDER, (whole, name: string, fallback: string | undefined) => {
    if (opts.keep?.includes(name)) return whole
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined
    const resolved = value ?? (fallback === undefined ? undefined : fallback.replace(/\\(.)/g, '$1'))
    if (resolved === undefined) {
      missing.add(name)
      return whole
    }
    return opts.escape ? escapeHtml(resolved) : resolved
  })
  return { output, missing: [...missing] }
}

/** True when the layout has exactly one {{content}} slot. */
export function hasOneContentSlot(layoutBody: string): boolean {
  return placeholders(layoutBody).filter((p) => p.name === CONTENT_SLOT).length === 1
}
