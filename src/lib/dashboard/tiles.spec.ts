import { describe, expect, it } from 'vitest'
import { DASHBOARD_TILES, hideTile, parseHiddenTiles, showTile, TILE_LABELS } from './tiles'

describe('dashboard tiles', () => {
  it('every tile has a name for its × and its way back', () => {
    for (const id of DASHBOARD_TILES) expect(TILE_LABELS[id]).toMatch(/\w/)
  })

  it('reads a list of known tiles, without duplicates, in board order', () => {
    expect(parseHiddenTiles(['apps', 'ask', 'apps'])).toEqual({ ok: true, hidden: ['ask', 'apps'] })
    expect(parseHiddenTiles([])).toEqual({ ok: true, hidden: [] })
  })

  it('refuses anything that is not a list of known tiles', () => {
    expect(parseHiddenTiles('apps')).toEqual({ ok: false, error: 'hidden must be a list of tiles' })
    expect(parseHiddenTiles(['apps', 'weather'])).toEqual({ ok: false, error: 'unknown dashboard tile "weather"' })
    expect(parseHiddenTiles([3])).toEqual({ ok: false, error: 'unknown dashboard tile 3' })
  })

  it('hides and shows one tile at a time', () => {
    expect(hideTile(['apps'], 'ask')).toEqual(['ask', 'apps'])
    expect(hideTile(['apps'], 'apps')).toEqual(['apps'])
    expect(showTile(['ask', 'apps'], 'ask')).toEqual(['apps'])
  })
})
