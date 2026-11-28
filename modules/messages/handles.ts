import type { Person } from './store'
import { coworkerSlugFromEmail } from '$lib/coworkers/handle'

/** A person's @handles and the people a body's @handles name (see notify.ts for the syntax). */

export function handlesOf(p: Person): string[] {
  if (p.kind === 'coworker') return [coworkerSlugFromEmail(p.email, p.id)]
  const out = new Set<string>()
  const local = p.email.split('@')[0]?.toLowerCase()
  if (local) out.add(local)
  const compact = p.name.replace(/\s+/g, '').toLowerCase()
  if (compact) out.add(compact)
  const first = p.name.trim().split(/\s+/)[0]?.toLowerCase()
  if (first) out.add(first)
  return [...out]
}

export function mentionedIds(body: string, people: readonly Person[]): string[] {
  const tokens = new Set([...body.matchAll(/(?:^|[^\w@])@([\w.+-]+)/g)].map((m) => m[1].toLowerCase().replace(/[.]+$/, '')))
  if (tokens.size === 0) return []
  return people.filter((p) => handlesOf(p).some((h) => tokens.has(h))).map((p) => p.id)
}
