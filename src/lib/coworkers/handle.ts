/**
 * A co-worker's @handle (plan/phase-ai-coworkers.md §6) — structure, safe on
 * the client and the server. The handle is its slug (unique,
 * coworker_profile.slug); its never-mailed address is built from it —
 * `<slug>.<first 8 of id>@coworker.invalid` — so the slug is read back from
 * the address by the exact inverse of that construction, checked against the
 * id. An address that is not one this code built fails loud.
 */

export const COWORKER_EMAIL_DOMAIN = 'coworker.invalid'

/** A co-worker's never-mailed address: `<slug>.<first 8 of id>@coworker.invalid` (reserved TLD). */
export function coworkerEmail(slug: string, userId: string): string {
  return `${slug}.${userId.slice(0, 8)}@${COWORKER_EMAIL_DOMAIN}`
}

export function coworkerSlugFromEmail(email: string, userId: string): string {
  const suffix = `.${userId.slice(0, 8)}@${COWORKER_EMAIL_DOMAIN}`
  const slug = email.endsWith(suffix) ? email.slice(0, -suffix.length) : ''
  if (!slug || coworkerEmail(slug, userId) !== email) {
    throw new Error(`co-worker ${userId} has the address ${JSON.stringify(email)}, which is not a co-worker address (<slug>.<id8>@${COWORKER_EMAIL_DOMAIN})`)
  }
  return slug
}

/**
 * What Messages highlights as an @mention of someone: a person's full and
 * first name; a co-worker's handle only, the exact token that asks it for a
 * turn (modules/messages/notify.ts handlesOf) — its name would light up
 * "@Nova" although that asks nobody.
 */
export function mentionNamesOf(p: { id: string; name: string; email: string; kind?: 'human' | 'coworker' }): string[] {
  if (p.kind === 'coworker') return [coworkerSlugFromEmail(p.email, p.id)]
  const first = p.name.trim().split(/\s+/)[0] ?? ''
  return [p.name, first].filter(Boolean)
}
