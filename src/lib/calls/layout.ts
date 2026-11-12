import { tilesOf, type CallParticipant, type CallTile } from './call-state'

/**
 * How the call uses its space (Contribute round 4: "make it dynamic and use
 * the space well"). Pure: the call view measures its stage and renders what
 * these say.
 *
 *   - a screen share → focus: the shared screen big, everyone in a strip
 *   - two people     → pair: the other person fills the stage, I am a small self view
 *   - otherwise      → grid: tiles sized to the count and the stage's aspect,
 *                      the active speaker emphasised
 */

export type Stage =
  | { mode: 'grid'; tiles: CallTile[]; speaker: string | null }
  | { mode: 'pair'; main: CallTile; self: CallTile; speaker: string | null }
  | { mode: 'focus'; main: CallTile; strip: CallTile[]; speaker: string | null }

export function stageOf(participants: readonly CallParticipant[], speaker: string | null): Stage {
  const tiles = tilesOf(participants)
  const screens = tiles.filter((t) => t.kind === 'screen')
  const cameras = tiles.filter((t) => t.kind === 'camera')
  if (screens.length > 0) {
    // Someone else's screen first: my own shared screen is the least useful big picture.
    const main = screens.find((t) => !t.isLocal) ?? screens[0]
    return { mode: 'focus', main, strip: [...screens.filter((t) => t !== main), ...cameras], speaker }
  }
  if (cameras.length === 2) {
    const self = cameras.find((t) => t.isLocal)
    const other = cameras.find((t) => !t.isLocal)
    if (self && other) return { mode: 'pair', main: other, self, speaker }
  }
  return { mode: 'grid', tiles: cameras, speaker }
}

/**
 * The active speaker: the remote person speaking now. They keep the emphasis
 * through a pause and lose it when someone else speaks or they leave. My own
 * voice never takes it (I know when I talk).
 */
export function nextSpeaker(prev: string | null, participants: readonly CallParticipant[]): string | null {
  const remote = participants.filter((p) => !p.isLocal)
  const now = remote.find((p) => p.speaking)
  if (now) return now.identity
  return prev && remote.some((p) => p.identity === prev) ? prev : null
}

export type Grid = { columns: number; rows: number; tileWidth: number; tileHeight: number }

/**
 * The column count that gives the biggest tiles of `aspect` for `count`
 * tiles in a width × height area (gaps between tiles included).
 */
export function gridLayout(o: { width: number; height: number; count: number; gap: number; aspect?: number }): Grid {
  const aspect = o.aspect ?? 16 / 9
  const count = Math.max(1, o.count)
  let best: Grid = { columns: 1, rows: count, tileWidth: 0, tileHeight: 0 }
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)
    const byWidth = (o.width - o.gap * (columns - 1)) / columns
    const byHeight = ((o.height - o.gap * (rows - 1)) / rows) * aspect
    const tileWidth = Math.max(0, Math.floor(Math.min(byWidth, byHeight)))
    if (tileWidth > best.tileWidth) best = { columns, rows, tileWidth, tileHeight: Math.floor(tileWidth / aspect + 1e-6) }
  }
  return best
}
