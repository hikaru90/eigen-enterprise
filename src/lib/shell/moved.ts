/** Where a page that moved now lives: the new base, the rest of the old path, the query string unchanged. */
export function movedHref(base: string, rest: string, search: string): string {
  return `${base}${rest === '' ? '' : `/${rest}`}${search}`
}
