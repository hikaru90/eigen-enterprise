import { describe, expect, it } from 'vitest'
import { appearanceOf, quadOf, rectOf, wrapText } from './annotate-model'
import { linesOf, svgOf } from './annotate-svg'

const measure = (s: string, size: number) => s.length * size * 0.5

describe('annotation appearances as SVG', () => {
  it('draws a highlight as a multiplied filled quad per line', () => {
    const [p] = svgOf(
      appearanceOf(
        { kind: 'Highlight', quads: [quadOf([10, 20, 110, 34])] },
        [1, 1, 0],
        '',
        measure,
      ),
    )
    expect(p).toEqual({
      kind: 'path',
      d: 'M10 34L110 34L110 20L10 20Z',
      fill: '#ffff00',
      stroke: 'none',
      width: 0,
      round: false,
      multiply: true,
    })
  })

  it('draws an ellipse and an arrow', () => {
    const [oval] = svgOf(
      appearanceOf(
        { kind: 'Circle', rect: [0, 0, 100, 50], width: 2, fill: null },
        [1, 0, 0],
        '',
        measure,
      ),
    )
    expect(oval).toMatchObject({
      kind: 'path',
      d: 'M1 25A49 24 0 1 0 99 25A49 24 0 1 0 1 25Z',
      stroke: '#ff0000',
    })
    const line = svgOf(
      appearanceOf(
        { kind: 'Line', line: [0, 0, 100, 0], width: 1, ends: ['None', 'ClosedArrow'] },
        [0, 0, 1],
        '',
        measure,
      ),
    )
    expect(line).toHaveLength(2)
    expect(line[1]).toMatchObject({ fill: '#0000ff' })
    expect(
      rectOf({ kind: 'Line', line: [0, 0, 100, 0], width: 1, ends: ['None', 'ClosedArrow'] }),
    ).toEqual([-7, -7, 107, 7])
  })

  it('wraps a text box’s text to its width', () => {
    expect(wrapText('one two three four', 40, 10, measure)).toEqual(['one two', 'three', 'four'])
    expect(wrapText('a\nb', 100, 10, measure)).toEqual(['a', 'b'])
  })

  it('turns a text selection’s boxes into one box per line', () => {
    expect(
      linesOf([
        [10, 100, 50, 112],
        [50, 101, 90, 112],
        [10, 84, 60, 96],
        [0, 0, 0.2, 0.2],
      ]),
    ).toEqual([
      [10, 100, 90, 112],
      [10, 84, 60, 96],
    ])
  })
})
