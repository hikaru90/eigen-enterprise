import { describe, expect, it } from 'vitest'
import {
  COMPANY_LOGO_ROUTE,
  companyLogoUrl,
  MAX_COMPANY_NAME_LENGTH,
  MAX_LOGO_BYTES,
  normalizeCompanyName,
  refuseLogoFile,
} from './identity'

const sha = 'a'.repeat(64)

describe('normalizeCompanyName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeCompanyName('  Kindred   Digital Labs ')).toEqual({ ok: true, name: 'Kindred Digital Labs' })
  })

  it.each([
    [undefined, 'The company name is required.'],
    ['   ', 'The company name is required.'],
    ['x'.repeat(MAX_COMPANY_NAME_LENGTH + 1), `The company name must be ${MAX_COMPANY_NAME_LENGTH} characters or fewer.`],
    ['Bad\u0007Name', "The company name contains characters that can't be shown."],
  ])('refuses %j with the reason', (raw, error) => {
    expect(normalizeCompanyName(raw)).toEqual({ ok: false, error })
  })

  it('keeps names in any script', () => {
    expect(normalizeCompanyName('Café Ünïcode 株式会社')).toEqual({ ok: true, name: 'Café Ünïcode 株式会社' })
  })
})

describe('companyLogoUrl', () => {
  it('names the bytes under the logo route', () => {
    expect(companyLogoUrl(sha)).toBe(`${COMPANY_LOGO_ROUTE}/${sha}`)
  })

  it('refuses anything but a sha256', () => {
    expect(() => companyLogoUrl('../etc/passwd')).toThrow(/sha256/)
  })
})

describe('refuseLogoFile (the type and size rules, checked before upload and again on the server)', () => {
  it('accepts every logo type within the size limit', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/PNG; charset=binary']) {
      expect(refuseLogoFile(type, 10)).toBeNull()
    }
    expect(refuseLogoFile('image/png', MAX_LOGO_BYTES)).toBeNull()
  })

  it.each([
    ['image/gif', 10, 415, 'A logo must be a PNG, JPEG, SVG or WebP image (got image/gif).'],
    ['', 10, 415, 'A logo must be a PNG, JPEG, SVG or WebP image (got no type).'],
    [null, 10, 415, 'A logo must be a PNG, JPEG, SVG or WebP image (got no type).'],
    ['image/png', 0, 400, 'The file is empty.'],
    ['image/png', MAX_LOGO_BYTES + 1, 413, 'The logo is too large (1025 KB; at most 1024 KB).'],
  ])('refuses %j of %i bytes with the reason', (type, size, status, error) => {
    expect(refuseLogoFile(type, size)).toEqual({ status, error })
  })
})
