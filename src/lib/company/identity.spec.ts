import { describe, expect, it } from 'vitest'
import { COMPANY_LOGO_ROUTE, companyLogoUrl, MAX_COMPANY_NAME_LENGTH, normalizeCompanyName } from './identity'

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
