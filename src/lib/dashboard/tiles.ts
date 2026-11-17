/**
 * The dashboard's tiles (Contribute 06894ad7, "pick your tiles"): each one can be
 * closed with its ×, and comes back from "Hidden tiles". The ones a person closed
 * are kept per user (user_preference.dashboard_hidden_tiles), so they stay hidden
 * on every device. Shared by the server (validation) and the dashboard.
 */

export const DASHBOARD_TILES = ['ask', 'needs-you', 'apps', 'activity', 'approvals'] as const
export type TileId = (typeof DASHBOARD_TILES)[number]

export const TILE_LABELS: Record<TileId, string> = {
  ask: 'Assistant',
  'needs-you': 'Waiting on you',
  apps: 'Apps',
  activity: 'Recent activity',
  approvals: 'Approvals and warnings',
}

const isTile = (value: unknown): value is TileId => (DASHBOARD_TILES as readonly unknown[]).includes(value)

/** A list of hidden tiles, in board order; anything else is refused. */
export function parseHiddenTiles(value: unknown): { ok: true; hidden: TileId[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'hidden must be a list of tiles' }
  const unknown = value.find((v) => !isTile(v))
  if (unknown !== undefined) return { ok: false, error: `unknown dashboard tile ${JSON.stringify(unknown)}` }
  return { ok: true, hidden: DASHBOARD_TILES.filter((id) => value.includes(id)) }
}

export function hideTile(hidden: readonly TileId[], id: TileId): TileId[] {
  return DASHBOARD_TILES.filter((t) => t === id || hidden.includes(t))
}

export function showTile(hidden: readonly TileId[], id: TileId): TileId[] {
  return hidden.filter((t) => t !== id)
}
