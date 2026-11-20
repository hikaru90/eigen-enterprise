import { describe, expect, it } from 'vitest'
import { readingLines, readingParagraphs, type PdfTextItem } from './reading'

/** An upright 12pt item at (x, y) — width is a rough 6pt per character. */
const at = (str: string, x: number, y: number, hasEOL = false): PdfTextItem => ({
  str,
  transform: [12, 0, 0, 12, x, y],
  width: str.length * 6,
  hasEOL,
})

describe('reading order from text items', () => {
  it('joins items on one baseline, spacing words that sit apart', () => {
    expect(
      readingLines([at('Hello', 72, 700), at('world', 110, 700), at('!', 140, 700)]).map(
        (l) => l.text,
      ),
    ).toEqual(['Hello world!'])
  })

  it('breaks lines when the baseline moves or an item ends a line', () => {
    const lines = readingLines([at('one', 72, 700, true), at('two', 72, 700), at('three', 72, 684)])
    expect(lines.map((l) => l.text)).toEqual(['one', 'two', 'three'])
  })

  it('keeps double-spaced text in one paragraph and breaks at wider gaps', () => {
    const items = [at('a', 72, 700), at('b', 72, 676), at('c', 72, 652), at('d', 72, 610)]
    expect(readingParagraphs(items)).toEqual(['a b c', 'd'])
  })

  it('a jump back up (a second column) starts a new paragraph, in content order', () => {
    const items = [
      at('left one', 72, 700),
      at('left two', 72, 686),
      at('right one', 320, 700),
      at('right two', 320, 686),
    ]
    expect(readingParagraphs(items)).toEqual(['left one left two', 'right one right two'])
  })

  it('reads text set at an angle in its own direction', () => {
    const r = (str: string, x: number, y: number): PdfTextItem => ({
      str,
      transform: [0, 12, -12, 0, x, y],
      width: 30,
      hasEOL: false,
    })
    // Rotated 90° counter-clockwise: baselines run up the page; the glyphs' top faces left, so the next line sits to the right.
    expect(readingParagraphs([r('first', 100, 72), r('second', 114, 72)])).toEqual(['first second'])
  })

  it('no items, no text', () => {
    expect(readingParagraphs([])).toEqual([])
    expect(readingParagraphs([at('', 0, 0, true), at('   ', 72, 700)])).toEqual([])
  })
})
