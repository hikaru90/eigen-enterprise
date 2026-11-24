import { z } from 'zod'

/**
 * A person types a site the way they say it: `www.example.com`. Structural
 * parse, not a guess: an input that already carries a scheme (`xxx://`) is
 * kept as typed, anything else is read as a bare host and given https://.
 * What is still not an http(s) URL with a host afterwards is refused.
 * Returns the normalised absolute URL, or null when it is not a usable site URL.
 */
export function normalizeSiteUrl(raw: string): string | null {
  const text = raw.trim()
  if (text.length === 0) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  const candidate = hasScheme ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return candidate
}

/** Zod field for a site URL: normalises a bare host, refuses the rest as a 400-able issue. */
export const siteUrlSchema = z.string().transform((raw, ctx) => {
  const url = normalizeSiteUrl(raw)
  if (url === null) {
    ctx.addIssue({
      code: 'custom',
      message: `"${raw.trim()}" is not a web address. Enter a site like www.example.com or https://example.com.`,
    })
    return z.NEVER
  }
  return url
})
