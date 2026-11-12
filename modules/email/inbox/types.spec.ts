import { describe, expect, it } from 'vitest'
import { normalizeLocalPart, suggestLocalPart } from './types'

describe('the local part of an address', () => {
  it('is trimmed and lower-cased', () => {
    expect(normalizeLocalPart('  Anna.Mueller ')).toEqual({ ok: true, value: 'anna.mueller' })
  })

  it('takes letters, digits and . _ + - inside', () => {
    expect(normalizeLocalPart('a_b+c-d.e1')).toEqual({ ok: true, value: 'a_b+c-d.e1' })
  })

  it.each([
    ['', 'Give the address a name before the @.'],
    ['.anna', 'An address can’t start or end with a dot, and can’t have two dots in a row.'],
    ['anna.', 'An address can’t start or end with a dot, and can’t have two dots in a row.'],
    ['an..na', 'An address can’t start or end with a dot, and can’t have two dots in a row.'],
    ['anna@x', 'Use only letters, digits and . _ + - before the @.'],
    ['an na', 'Use only letters, digits and . _ + - before the @.'],
    ['jürgen', 'Use only letters, digits and . _ + - before the @.'],
    ['a'.repeat(65), 'Keep the part before the @ to 64 characters.'],
  ])('rejects %j', (input, message) => {
    expect(normalizeLocalPart(input)).toEqual({ ok: false, message })
  })
})

describe('the suggested address for a member', () => {
  it('is firstname.lastname', () => {
    expect(suggestLocalPart({ firstName: 'Anna', lastName: 'Berg', name: 'Anna Berg' })).toBe('anna.berg')
  })

  it('spells out German umlauts and ß, and drops other accents', () => {
    expect(suggestLocalPart({ firstName: 'Jürgen', lastName: 'Größe', name: '' })).toBe('juergen.groesse')
    expect(suggestLocalPart({ firstName: 'Zoë', lastName: 'Dupré', name: '' })).toBe('zoe.dupre')
  })

  it('joins several given or family names with dots', () => {
    expect(suggestLocalPart({ firstName: 'Mary Ann', lastName: 'van der Berg', name: '' })).toBe('mary.ann.van.der.berg')
  })

  it('falls back to the display name when the profile has no first/last name', () => {
    expect(suggestLocalPart({ firstName: null, lastName: null, name: 'Ben Ode' })).toBe('ben.ode')
  })

  it('suggests nothing when no usable letters are left', () => {
    expect(suggestLocalPart({ firstName: null, lastName: null, name: '李雷' })).toBeNull()
  })
})
