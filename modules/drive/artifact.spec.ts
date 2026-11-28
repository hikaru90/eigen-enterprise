import { describe, expect, it } from 'vitest'
import { applySlideOps, applyTextEdits, artifactFileName, artifactKindOf, deckDocument, deckSlides } from './artifact'

describe('artifact kinds and names', () => {
  it('reads the kind from the file name', () => {
    expect(artifactKindOf('Pitch.deck.html')).toBe('deck')
    expect(artifactKindOf('Landing.html')).toBe('page')
    expect(artifactKindOf('old.htm')).toBe('page')
    expect(artifactKindOf('notes.md')).toBeNull()
  })

  it('names a new artifact by its kind', () => {
    expect(artifactFileName('deck', 'Pitch')).toBe('Pitch.deck.html')
    expect(artifactFileName('deck', 'Pitch.html')).toBe('Pitch.deck.html')
    expect(artifactFileName('page', 'Landing')).toBe('Landing.html')
    expect(artifactFileName('page', 'Landing.html')).toBe('Landing.html')
    expect(() => artifactFileName('page', '  ')).toThrow(/needs a name/)
  })
})

describe('decks', () => {
  const deck = deckDocument({ title: 'Seed <round>', css: 'h1{color:red}', slides: ['<h1>One</h1>', '<h1>Two</h1>'] })

  it('lays out each slide on its own stage, escapes the title and keeps the css', () => {
    expect(deck).toContain('<title>Seed &lt;round&gt;</title>')
    expect(deck).toContain('h1{color:red}')
    expect(deck).toContain('@page{size:1920px 1080px')
    expect(deckSlides(deck)).toEqual(['<h1>One</h1>', '<h1>Two</h1>'])
  })

  it('replaces, inserts, moves and deletes single slides and keeps the rest', () => {
    const next = applySlideOps(deck, [
      { op: 'replace', index: 0, html: '<h1>Uno</h1>' },
      { op: 'insert', index: 2, html: '<h1>Three</h1>' },
      { op: 'move', from: 2, to: 0 },
      { op: 'delete', index: 2 },
    ])
    expect(deckSlides(next)).toEqual(['<h1>Three</h1>', '<h1>Uno</h1>'])
    expect(next).toContain('h1{color:red}')
  })

  it('refuses a slide index that does not exist and marker comments inside a slide', () => {
    expect(() => applySlideOps(deck, [{ op: 'delete', index: 5 }])).toThrow(/Slide 5 does not exist; the deck has 2 slides/)
    expect(() => deckDocument({ title: 't', slides: ['<!--ee-slide-->'] })).toThrow(/marker/)
  })

  it('says so when the markers are gone', () => {
    expect(() => applySlideOps('<html></html>', [{ op: 'delete', index: 0 }])).toThrow(/lost its slide markers/)
  })
})

describe('text edits', () => {
  it('replaces each unique occurrence in order', () => {
    expect(applyTextEdits('a b c', [{ find: 'b', replace: 'B' }, { find: 'B c', replace: 'x' }])).toBe('a x')
  })

  it('refuses a missing or repeated find', () => {
    expect(() => applyTextEdits('a a', [{ find: 'a', replace: 'b' }])).toThrow(/more than once/)
    expect(() => applyTextEdits('a', [{ find: 'z', replace: 'b' }])).toThrow(/does not occur/)
  })
})
