import type { CallParticipant, CallTile } from './call-state'
import { describe, expect, it } from 'vitest'
import { gridLayout, nextSpeaker, stageOf } from './layout'

const person = (identity: string, over: Partial<CallParticipant> = {}): CallParticipant => ({
  identity,
  name: identity.toUpperCase(),
  isLocal: false,
  micOn: true,
  cameraOn: false,
  speaking: false,
  camera: null,
  screen: null,
  ...over,
})
const me = (over: Partial<CallParticipant> = {}) => person('me', { isLocal: true, ...over })
const keys = (tiles: CallTile[]) => tiles.map((t) => t.key)

describe('gridLayout', () => {
  it('one tile takes the largest 16:9 box that fits', () => {
    expect(gridLayout({ width: 1600, height: 900, count: 1, gap: 0 })).toEqual({ columns: 1, rows: 1, tileWidth: 1600, tileHeight: 900 })
    // A tall window: width-bound.
    expect(gridLayout({ width: 375, height: 700, count: 1, gap: 0 })).toMatchObject({ columns: 1, tileWidth: 375 })
  })

  it('a wide window puts two people side by side, a tall (phone) window stacks them', () => {
    expect(gridLayout({ width: 1600, height: 600, count: 2, gap: 8 })).toMatchObject({ columns: 2, rows: 1 })
    expect(gridLayout({ width: 375, height: 700, count: 2, gap: 8 })).toMatchObject({ columns: 1, rows: 2 })
  })

  it('picks the column count that makes tiles biggest, never wider or taller than the area', () => {
    for (const [width, height] of [
      [1280, 720],
      [375, 600],
      [900, 900],
    ] as const) {
      for (const count of [3, 4, 5, 6, 9]) {
        const g = gridLayout({ width, height, count, gap: 8 })
        expect(g.columns * g.rows).toBeGreaterThanOrEqual(count)
        expect(g.columns * g.tileWidth + (g.columns - 1) * 8).toBeLessThanOrEqual(width + 0.5)
        expect(g.rows * g.tileHeight + (g.rows - 1) * 8).toBeLessThanOrEqual(height + 0.5)
        expect(g.tileWidth / g.tileHeight).toBeCloseTo(16 / 9, 1)
        // No other column count gives a bigger tile.
        for (let c = 1; c <= count; c++) {
          const r = Math.ceil(count / c)
          const w = Math.min((width - 8 * (c - 1)) / c, ((height - 8 * (r - 1)) / r) * (16 / 9))
          expect(w).toBeLessThanOrEqual(g.tileWidth + 1)
        }
      }
    }
    // 4 people in a 16:9 window: a 2 × 2 grid.
    expect(gridLayout({ width: 1280, height: 720, count: 4, gap: 8 })).toMatchObject({ columns: 2, rows: 2 })
  })

  it('an area not measured yet gives zero-size tiles, not NaN', () => {
    expect(gridLayout({ width: 0, height: 0, count: 3, gap: 8 })).toMatchObject({ tileWidth: 0, tileHeight: 0 })
  })
})

describe('stageOf', () => {
  it('alone: just me, as one tile', () => {
    const s = stageOf([me()], null)
    expect(s.mode).toBe('grid')
    expect(s.mode === 'grid' && keys(s.tiles)).toEqual(['me:camera'])
  })

  it('two people: the other person fills the stage, I am a small self view', () => {
    const s = stageOf([me(), person('ben')], null)
    expect(s.mode).toBe('pair')
    if (s.mode !== 'pair') throw new Error('pair expected')
    expect(s.main.key).toBe('ben:camera')
    expect(s.self.key).toBe('me:camera')
  })

  it('three or more: a grid, the active speaker emphasised', () => {
    const s = stageOf([me(), person('ben'), person('cy')], 'cy')
    expect(s.mode).toBe('grid')
    if (s.mode !== 'grid') throw new Error('grid expected')
    expect(keys(s.tiles)).toEqual(['me:camera', 'ben:camera', 'cy:camera'])
    expect(s.speaker).toBe('cy')
  })

  it('a screen share takes the big area, everyone (camera tiles) goes into the strip', () => {
    const screen = {} as MediaStream
    const s = stageOf([me(), person('ben', { screen }), person('cy')], 'cy')
    expect(s.mode).toBe('focus')
    if (s.mode !== 'focus') throw new Error('focus expected')
    expect(s.main.key).toBe('ben:screen')
    expect(keys(s.strip)).toEqual(['me:camera', 'ben:camera', 'cy:camera'])
    expect(s.speaker).toBe('cy')
  })

  it('two screen shares: the first is big, the second joins the strip', () => {
    const screen = {} as MediaStream
    const s = stageOf([me({ screen }), person('ben', { screen })], null)
    if (s.mode !== 'focus') throw new Error('focus expected')
    expect(s.main.key).toBe('ben:screen')
    expect(keys(s.strip)).toEqual(['me:screen', 'me:camera', 'ben:camera'])
  })
})

describe('nextSpeaker', () => {
  it('the remote person speaking now; stays the speaker through silence; cleared when they leave', () => {
    let s = nextSpeaker(null, [me(), person('ben'), person('cy', { speaking: true })])
    expect(s).toBe('cy')
    s = nextSpeaker(s, [me(), person('ben'), person('cy')])
    expect(s).toBe('cy')
    s = nextSpeaker(s, [me(), person('ben', { speaking: true }), person('cy')])
    expect(s).toBe('ben')
    s = nextSpeaker(s, [me(), person('cy')])
    expect(s).toBeNull()
  })

  it('me speaking does not take the emphasis from the others', () => {
    expect(nextSpeaker('ben', [me({ speaking: true }), person('ben')])).toBe('ben')
    expect(nextSpeaker(null, [me({ speaking: true }), person('ben')])).toBeNull()
  })
})
