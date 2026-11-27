/**
 * Where someone is working (plan/phase-multiplayer-presence.md): the shared
 * contract between a tab's heartbeat, the server's tracker and the live
 * presence feed. Pure types + validation of shape (structure only — the page
 * declares its item, nothing is inferred from text).
 */

/** The things a page can say it has open. */
export const WHERE_ITEM_KINDS = ['conversation', 'drive_file', 'drive_folder'] as const
export type WhereItemKind = (typeof WHERE_ITEM_KINDS)[number]

export type WhereItem = { kind: WhereItemKind; id: string }

/** The dashboard (`/`) is an area of its own; every other area is a sidebar entry id. */
export const DASHBOARD_AREA = 'dashboard'

/** What one tab reports with each heartbeat (`where` in POST /api/messages/presence). */
export type WhereReport = {
  /** The sidebar entry id (`currentNavId`), `dashboard` on `/`, null on a page outside both. */
  area: string | null
  /** The page's pathname, without query or hash. */
  path: string
  /** The one thing open on the page, declared by the page; null when nothing is. */
  item: WhereItem | null
}

/**
 * What one viewer is shown about someone's place — already filtered for that
 * viewer by the server: the item (and the path, which carries its id) only
 * when the viewer may open it themselves.
 */
export type WhereView = {
  area: string | null
  path: string | null
  item: (WhereItem & { title: string }) | null
}

const AREA = /^[a-z][a-z0-9_-]{0,63}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_PATH = 512

/** Parses a heartbeat's `where`; throws with a reason when its shape is wrong. */
export function parseWhereReport(value: unknown): WhereReport {
  if (typeof value !== 'object' || value === null) throw new Error('where must be an object')
  const { area, path, item } = value as Record<string, unknown>
  if (area !== null && (typeof area !== 'string' || !AREA.test(area)))
    throw new Error('where.area must be a sidebar entry id or null')
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH || /[?#]/.test(path))
    throw new Error('where.path must be a pathname (starts with /, no query or hash, ≤ 512 chars)')
  let parsed: WhereItem | null = null
  if (item !== null) {
    if (typeof item !== 'object') throw new Error('where.item must be an object or null')
    const { kind, id } = item as Record<string, unknown>
    if (typeof kind !== 'string' || !(WHERE_ITEM_KINDS as readonly string[]).includes(kind))
      throw new Error(`where.item.kind must be one of ${WHERE_ITEM_KINDS.join(', ')}`)
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('where.item.id must be an id')
    parsed = { kind: kind as WhereItemKind, id }
  }
  return { area: area as string | null, path, item: parsed }
}

export const sameWhere = (a: WhereReport | null, b: WhereReport | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.area === b.area &&
    a.path === b.path &&
    a.item?.kind === b.item?.kind &&
    a.item?.id === b.item?.id)
