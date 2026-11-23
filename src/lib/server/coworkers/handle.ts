import { COWORKER_EMAIL_DOMAIN, coworkerEmail } from './service'

/**
 * A co-worker's @handle is its slug (unique, coworker_profile.slug). Its
 * never-mailed address is built from it — `<slug>.<first 8 of id>@coworker.invalid`
 * (service.ts coworkerEmail) — so the slug is read back from the address by the
 * exact inverse of that construction, checked against the id: structure, not a
 * guess. An address that is not one this code built fails loud.
 */
export function coworkerSlugFromEmail(email: string, userId: string): string {
  const suffix = `.${userId.slice(0, 8)}@${COWORKER_EMAIL_DOMAIN}`
  const slug = email.endsWith(suffix) ? email.slice(0, -suffix.length) : ''
  if (!slug || coworkerEmail(slug, userId) !== email) {
    throw new Error(`co-worker ${userId} has the address ${JSON.stringify(email)}, which is not a co-worker address (<slug>.<id8>@${COWORKER_EMAIL_DOMAIN})`)
  }
  return slug
}
