import { describe, expect, it } from 'vitest'
import { anchorName, markerSpots, openCount } from './comment-view'
import { openDeck } from './model'
import { commentedPptx } from './test-utils/comment-fixtures'

describe('comment markers', () => {
  const d = openDeck(commentedPptx()).deck

  it('sit at the comment position, else at the top-right of its shape; resolved threads have none', () => {
    const spots = markerSpots(d, d.slides[0]!)
    expect(spots.map((s) => [s.id, s.n])).toEqual([
      ['{C1}', 1],
      ['{C3}', 3],
    ])
    expect(spots[0]!.x).toBeCloseTo(914400 / 12192000)
    expect(spots[0]!.y).toBeCloseTo(457200 / 6858000)
    expect(spots[1]!.x).toBeCloseTo((952500 + 2857500) / 12192000)
    expect(spots[1]!.y).toBeCloseTo(2857500 / 6858000)
    expect(markerSpots(d, d.slides[1]!)).toMatchObject([{ legacy: true, n: 1 }])
  })

  it('counts open threads per slide and names the shape a comment is on', () => {
    expect(d.slides.map(openCount)).toEqual([2, 1, 0])
    const [c1, c2] = d.slides[0]!.comments.threads
    expect(anchorName(d.slides[0]!, c1!)).toBeNull()
    expect(anchorName(d.slides[0]!, c2!)).toBe('Box')
  })
})
