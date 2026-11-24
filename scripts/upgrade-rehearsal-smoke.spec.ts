import { describe, expect, it } from 'vitest'
import { first, SMOKE, summarize } from './upgrade-rehearsal-smoke.mjs'

describe('the rehearsal read smoke list', () => {
  it('every entry has a unique name: outputs are keyed by it', () => {
    const names = SMOKE.map((s) => s.as ?? s.tool)
    expect(new Set(names).size).toBe(names.length)
  })

  it('a get reads its id from an entry that runs before it', () => {
    const seen = new Set<string>()
    for (const s of SMOKE) {
      if (typeof s.input === 'function') {
        // With no outputs yet, the input names the earlier read it needs.
        let msg = ''
        try {
          s.input({})
        } catch (err) {
          msg = (err as Error).message
        }
        const from = /^not run: it reads an id from (.+), which failed$/.exec(msg)?.[1]
        expect(from, `${s.as ?? s.tool}: ${msg}`).toBeDefined()
        expect(
          seen.has(from!),
          `${s.as ?? s.tool} reads ${from}, which runs later or not at all`,
        ).toBe(true)
      }
      seen.add(s.as ?? s.tool)
    }
  })
})

describe('first (a get takes the first id of a list)', () => {
  it('from a field of the output, or the output itself', () => {
    expect(
      first(
        { 'contacts.list': { contacts: [{ id: 'c1' }, { id: 'c2' }] } },
        'contacts.list',
        'contacts',
        'id',
      ),
    ).toBe('c1')
    expect(
      first({ 'website.list_pages': [{ slug: 'home' }] }, 'website.list_pages', null, 'slug'),
    ).toBe('home')
  })

  it('fails loud on an empty list or a missing field', () => {
    expect(() =>
      first({ 'contacts.list': { contacts: [] } }, 'contacts.list', 'contacts', 'id'),
    ).toThrow(/contacts\.list returned no contacts/)
    expect(() =>
      first({ 'contacts.list': { contacts: [{ name: 'x' }] } }, 'contacts.list', 'contacts', 'id'),
    ).toThrow(/has no id/)
  })
})

describe('summarize (what is compared before and after the migrations)', () => {
  it('lists count, objects list their fields with array lengths, sorted', () => {
    expect(summarize([1, 2, 3])).toBe('3 items')
    expect(summarize({ tags: ['a'], contacts: [1, 2], count: 2 })).toBe('contacts[2] count tags[1]')
  })

  it('leaves values out: timestamps and relative dates do not make a difference', () => {
    expect(summarize({ updatedAt: '2026-11-24' })).toBe(summarize({ updatedAt: '2026-11-25' }))
    expect(summarize(null)).toBe('object')
    expect(summarize('x')).toBe('string')
  })
})
