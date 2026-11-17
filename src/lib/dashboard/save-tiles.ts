import type { TileId } from './tiles'

/** Saves the tiles a person closed (PUT /api/settings/dashboard-tiles); fails loud with the server's reason. */
export async function saveHiddenTiles(fetcher: typeof fetch, hidden: TileId[]): Promise<void> {
  const res = await fetcher('/api/settings/dashboard-tiles', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hidden }),
  })
  if (res.ok) return
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  throw new Error(typeof body?.error === 'string' ? body.error : `the server answered ${res.status}`)
}
