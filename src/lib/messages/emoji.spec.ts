import data from 'emojibase-data/en/data.json'
import messages from 'emojibase-data/en/messages.json'
import { describe, expect, it } from 'vitest'
import { REACTION_EMOJI } from '../../../modules/messages/service'
import { isSingleEmoji, MAX_EMOJI_CODEPOINTS } from './emoji'
import { buildEmojiCatalog, PICKER_MAX_EMOJI_VERSION, searchEmoji } from './emoji-catalog'
import { parseRecentEmoji, pushRecentEmoji, RECENT_EMOJI_MAX } from './emoji-recent'

describe('isSingleEmoji (the reaction rule: one RGI emoji, by Unicode property)', () => {
  it.each([
    ['👍', 'thumbs up'],
    ['❤️', 'red heart (fully qualified)'],
    ['👍🏽', 'skin tone'],
    ['👨‍👩‍👧‍👦', 'ZWJ family'],
    ['🇩🇪', 'flag'],
    ['🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'subdivision flag'],
    ['1️⃣', 'keycap'],
    ['🦒', 'giraffe (not in the quick row)'],
    ['©️', 'copyright (fully qualified)'],
  ])('accepts %s (%s)', (e) => {
    expect(isSingleEmoji(e)).toBe(true)
  })

  it.each([
    ['', 'empty'],
    ['lol', 'text'],
    ['a', 'a letter'],
    ['1', 'a digit'],
    ['❤', 'an unqualified heart (would duplicate ❤️)'],
    ['©', 'unqualified copyright'],
    ['👍👍', 'two emoji'],
    ['👍 ', 'trailing space'],
    [' 👍', 'leading space'],
    ['👍\n', 'newline'],
    ['<b>👍</b>', 'markup'],
    ['‍', 'a bare zero-width joiner'],
    ['👍'.repeat(200), 'a long run'],
  ])('refuses %j (%s)', (e) => {
    expect(isSingleEmoji(e)).toBe(false)
  })

  it('refuses non-strings', () => {
    for (const v of [undefined, null, 42, ['👍'], { emoji: '👍' }]) expect(isSingleEmoji(v)).toBe(false)
  })

  it('caps the length at the database limit, in code points', () => {
    expect(MAX_EMOJI_CODEPOINTS).toBe(16)
    // The longest RGI sequences (subdivision flags, families) fit.
    expect([...'🏴󠁧󠁢󠁷󠁬󠁳󠁿'].length).toBeLessThanOrEqual(MAX_EMOJI_CODEPOINTS)
  })

  it('every quick-row emoji is a valid reaction', () => {
    for (const e of REACTION_EMOJI) expect(isSingleEmoji(e)).toBe(true)
  })
})

describe('buildEmojiCatalog (the full picker, from the Unicode emoji dataset)', () => {
  const catalog = buildEmojiCatalog(data, messages)
  const all = catalog.groups.flatMap((g) => g.emoji)

  it('groups in Unicode order with readable names; no components, no bare regional indicators', () => {
    expect(catalog.groups.map((g) => g.key)).toEqual([
      'smileys-emotion',
      'people-body',
      'animals-nature',
      'food-drink',
      'travel-places',
      'activities',
      'objects',
      'symbols',
      'flags',
    ])
    expect(catalog.groups[0].label).toBe('Smileys & emotion')
    expect(all.some((e) => e.emoji === '🏽')).toBe(false)
    expect(all.some((e) => e.emoji === '🇦')).toBe(false)
  })

  it('has every emoji up to the picker’s version cap, thousands of them, each once', () => {
    expect(all.length).toBeGreaterThan(1800)
    expect(new Set(all.map((e) => e.emoji)).size).toBe(all.length)
    expect(all.find((e) => e.emoji === '🦒')).toMatchObject({ label: 'giraffe' })
    // Too new for many fonts (and maybe for the server's Unicode tables) → not offered.
    const tooNew = data.filter((e) => e.version > PICKER_MAX_EMOJI_VERSION).map((e) => e.emoji)
    expect(tooNew.length).toBeGreaterThan(0)
    for (const e of tooNew) expect(all.some((x) => x.emoji === e)).toBe(false)
  })

  it('everything the picker offers is accepted by the server rule', () => {
    const refused = all.filter((e) => !isSingleEmoji(e.emoji)).map((e) => e.emoji)
    expect(refused).toEqual([])
  })

  it('offers the whole quick row too', () => {
    for (const e of REACTION_EMOJI) expect(all.some((x) => x.emoji === e)).toBe(true)
  })

  it('search matches the name and the dataset’s keywords, every word, in dataset order', () => {
    expect(searchEmoji(catalog, 'giraffe').map((e) => e.emoji)).toEqual(['🦒'])
    expect(searchEmoji(catalog, '  Red   HEART ').map((e) => e.emoji)).toContain('❤️')
    expect(searchEmoji(catalog, '+1').map((e) => e.emoji)).toContain('👍')
    expect(searchEmoji(catalog, 'zzzz-nothing')).toEqual([])
    expect(searchEmoji(catalog, '   ')).toEqual([])
  })
})

describe('recently used emoji (per browser)', () => {
  it('most recent first, no duplicates, capped', () => {
    expect(pushRecentEmoji(['🎉', '👍'], '👍')).toEqual(['👍', '🎉'])
    expect(pushRecentEmoji([], '🦒')).toEqual(['🦒'])
    const many = Array.from({ length: RECENT_EMOJI_MAX }, (_, i) => String.fromCodePoint(0x1f600 + i))
    const next = pushRecentEmoji(many, '🦒')
    expect(next).toHaveLength(RECENT_EMOJI_MAX)
    expect(next[0]).toBe('🦒')
  })

  it('reads only valid emoji back from storage', () => {
    expect(parseRecentEmoji(JSON.stringify(['🦒', 'lol', 7, '👍']))).toEqual(['🦒', '👍'])
    expect(parseRecentEmoji(null)).toEqual([])
    expect(parseRecentEmoji('not json')).toEqual([])
    expect(parseRecentEmoji('{"a":1}')).toEqual([])
  })
})
