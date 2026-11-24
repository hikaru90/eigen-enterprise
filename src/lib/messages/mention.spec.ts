import { describe, expect, it } from 'vitest'
import { insertMention, matchMentions, mentionAt, type Mentionable } from './mention'

const olga: Mentionable = { id: 'u-olga', name: 'Olga Owner', handle: 'olga', kind: 'human' }
const bea: Mentionable = { id: 'u-bea', name: 'Bea Marquez', handle: 'bea.m', kind: 'human' }
const nova: Mentionable = { id: 'cw-nova', name: 'Nova Lee', handle: 'nova-mwujrl74', kind: 'coworker' }
const noah: Mentionable = { id: 'u-noah', name: 'Noah Novak', handle: 'nn', kind: 'human' }
const all = [olga, bea, nova, noah]

describe('mentionAt (the @word being typed at the caret)', () => {
  it('finds the @word ending at the caret, with where it starts', () => {
    expect(mentionAt('hi @nov', 7)).toEqual({ start: 3, query: 'nov' })
    expect(mentionAt('@nov', 4)).toEqual({ start: 0, query: 'nov' })
    expect(mentionAt('(@be', 4)).toEqual({ start: 1, query: 'be' })
  })

  it('reads the same token characters the server reads (letters, digits, _ . + -)', () => {
    expect(mentionAt('@nova-mw', 8)).toEqual({ start: 0, query: 'nova-mw' })
    expect(mentionAt('@bea.', 5)).toEqual({ start: 0, query: 'bea.' })
  })

  it('is nothing for a bare @, an email address, a space after the word, or the caret elsewhere', () => {
    expect(mentionAt('hi @', 4)).toBeNull()
    expect(mentionAt('mail olga@example', 17)).toBeNull()
    expect(mentionAt('@@nov', 5)).toBeNull()
    expect(mentionAt('@nov ', 5)).toBeNull()
    expect(mentionAt('@nov and more', 13)).toBeNull()
    expect(mentionAt('no mention', 10)).toBeNull()
  })

  it('looks only at the text before the caret', () => {
    expect(mentionAt('@nova later', 3)).toEqual({ start: 0, query: 'no' })
  })
})

describe('matchMentions (who the @word can mean)', () => {
  it('matches the start of the handle, the name, or any word of the name, ignoring case', () => {
    expect(matchMentions(all, 'nov').map((m) => m.id)).toEqual(['cw-nova', 'u-noah'])
    expect(matchMentions(all, 'MARQ').map((m) => m.id)).toEqual(['u-bea'])
    expect(matchMentions(all, 'bea.').map((m) => m.id)).toEqual(['u-bea'])
    expect(matchMentions(all, 'nn').map((m) => m.id)).toEqual(['u-noah'])
  })

  it('puts handle and first-name matches before later-word matches', () => {
    // "Noah Novak" matches "nov" on its last name only; Nova on handle and first name.
    expect(matchMentions(all, 'no').map((m) => m.id)).toEqual(['u-noah', 'cw-nova'])
    expect(matchMentions(all, 'nova').map((m) => m.id)).toEqual(['cw-nova', 'u-noah'])
  })

  it('leaves out the writer and caps the list', () => {
    expect(matchMentions(all, 'o', { exclude: 'u-olga' }).map((m) => m.id)).not.toContain('u-olga')
    const many = Array.from({ length: 20 }, (_, i): Mentionable => ({ id: `u${i}`, name: `Ann ${i}`, handle: `ann${i}`, kind: 'human' }))
    expect(matchMentions(many, 'ann', { limit: 5 })).toHaveLength(5)
    expect(matchMentions(many, 'ann')).toHaveLength(8)
  })

  it('is nothing for no match', () => {
    expect(matchMentions(all, 'zed')).toEqual([])
  })
})

describe('insertMention (the picked member goes in as the token that reaches them)', () => {
  it('replaces the @word with @handle and a space, the caret after it', () => {
    expect(insertMention('hi @nov', 3, 7, nova)).toEqual({ text: 'hi @nova-mwujrl74 ', selectionStart: 18, selectionEnd: 18 })
  })

  it('replaces the rest of the word after the caret too, and reuses a following space', () => {
    expect(insertMention('@nova later', 0, 3, nova)).toEqual({ text: '@nova-mwujrl74 later', selectionStart: 15, selectionEnd: 15 })
    expect(insertMention('ask @be now', 4, 7, bea)).toEqual({ text: 'ask @bea.m now', selectionStart: 11, selectionEnd: 11 })
  })
})
