import { describe, expect, it } from 'vitest'
import { avatarUrl, initialsOf, isProfileComplete, normalizeProfileNames, safeNextPath } from './profile'

const SHA = 'ab'.repeat(32)

describe('isProfileComplete', () => {
  it('needs a first name, a last name and a stored picture', () => {
    expect(isProfileComplete({ firstName: 'Ada', lastName: 'Lovelace', avatarSha256: SHA })).toBe(true)
    expect(isProfileComplete({ firstName: 'Ada', lastName: 'Lovelace', avatarSha256: null })).toBe(false)
    expect(isProfileComplete({ firstName: 'Ada', lastName: '  ', avatarSha256: SHA })).toBe(false)
    expect(isProfileComplete({ firstName: null, lastName: 'Lovelace', avatarSha256: SHA })).toBe(false)
    expect(isProfileComplete({ firstName: 'Ada', lastName: 'Lovelace', avatarSha256: 'not-a-sha' })).toBe(false)
    expect(isProfileComplete(null)).toBe(false)
  })
})

describe('normalizeProfileNames', () => {
  it('trims, collapses inner whitespace and composes "First Last"', () => {
    expect(normalizeProfileNames({ firstName: '  Ada ', lastName: 'King  Lovelace ' })).toEqual({
      ok: true,
      firstName: 'Ada',
      lastName: 'King Lovelace',
      name: 'Ada King Lovelace',
    })
  })

  it('refuses a missing, blank, too long or control-character name with the reason', () => {
    expect(normalizeProfileNames({ lastName: 'Lovelace' })).toEqual({ ok: false, error: 'First name is required.' })
    expect(normalizeProfileNames({ firstName: 'Ada', lastName: '   ' })).toEqual({ ok: false, error: 'Last name is required.' })
    expect(normalizeProfileNames({ firstName: 'A'.repeat(51), lastName: 'L' })).toMatchObject({ ok: false, error: expect.stringContaining('50 characters') })
    expect(normalizeProfileNames({ firstName: 'Ada\u0000', lastName: 'L' })).toMatchObject({ ok: false })
    expect(normalizeProfileNames({ firstName: 42, lastName: 'L' })).toMatchObject({ ok: false })
  })
})

describe('safeNextPath', () => {
  it('keeps same-origin paths with their query', () => {
    expect(safeNextPath('/messages?c=abc')).toBe('/messages?c=abc')
    expect(safeNextPath('/')).toBe('/')
  })

  it('never redirects off-site or back into the step', () => {
    expect(safeNextPath(null)).toBe('/')
    expect(safeNextPath('https://evil.example')).toBe('/')
    expect(safeNextPath('//evil.example')).toBe('/')
    expect(safeNextPath('/\\evil.example')).toBe('/')
    expect(safeNextPath('/x\nSet-Cookie')).toBe('/')
    expect(safeNextPath('/welcome/profile?next=/')).toBe('/')
  })
})

describe('avatarUrl / initialsOf', () => {
  it('serves pictures by their sha256 only', () => {
    expect(avatarUrl(SHA)).toBe(`/api/people/avatar/${SHA}`)
    expect(() => avatarUrl('../etc/passwd')).toThrow()
  })

  it('takes the first and last initials', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL')
    expect(initialsOf('ada king lovelace')).toBe('AL')
    expect(initialsOf('Madonna')).toBe('M')
    expect(initialsOf('  ')).toBe('?')
    expect(initialsOf(null)).toBe('?')
  })
})
