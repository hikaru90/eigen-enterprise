import { resolve } from '$app/paths'
import type { Pathname } from '$app/types'

/**
 * resolve() for a pathname held in data (nav items, settings slots). resolve's
 * typed overloads don't accept a union of pathnames, so the argument tuple is
 * widened to resolve's own parameter type — no behaviour beyond resolve().
 */
export function appHref(path: Pathname): string {
  return resolve(...([path] as unknown as Parameters<typeof resolve>))
}
