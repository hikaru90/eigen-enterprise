import { describe, expect, it } from 'vitest'
import { REQUIRED_VISUAL_ROLES } from '../store'
import { SECTION_DRIVERS, SPECIMEN_SECTIONS, tokenDrivers, type SpecimenSectionId } from './drivers'

const TOKEN_NAME = /^--[a-z0-9-]+$/

describe('SECTION_DRIVERS — click-to-highlight knowledge base (phase-2d M6/V8)', () => {
  it('is total over the specimen sections: every element has at least one driving token', () => {
    expect([...SPECIMEN_SECTIONS].sort()).toEqual(
      ['cards', 'footer', 'form', 'hero', 'nav', 'pricing'].sort(),
    )
    for (const section of SPECIMEN_SECTIONS) {
      expect(SECTION_DRIVERS[section].length, `section ${section}`).toBeGreaterThan(0)
    }
  })

  it('covers every REQUIRED_VISUAL_ROLE in at least one driver group (V9 activation surface)', () => {
    const known = new Set(SPECIMEN_SECTIONS.flatMap((section) => SECTION_DRIVERS[section]))
    for (const role of REQUIRED_VISUAL_ROLES) {
      expect(known.has(`--${role}`), `required role --${role}`).toBe(true)
    }
  })

  it('uses valid css custom-property names only', () => {
    for (const section of SPECIMEN_SECTIONS) {
      for (const token of SECTION_DRIVERS[section]) {
        expect(token).toMatch(TOKEN_NAME)
      }
    }
  })

  it('has no duplicate tokens inside a driver group', () => {
    for (const section of SPECIMEN_SECTIONS) {
      expect(new Set(SECTION_DRIVERS[section]).size).toBe(SECTION_DRIVERS[section].length)
    }
  })
})

describe('tokenDrivers — both directions', () => {
  const drivers = tokenDrivers()

  it('exposes element→tokens and token→elements', () => {
    for (const section of SPECIMEN_SECTIONS) {
      expect(drivers.sectionTokens[section]).toEqual(SECTION_DRIVERS[section])
    }
  })

  it('is consistent: every listed token resolves back to its section', () => {
    for (const section of SPECIMEN_SECTIONS) {
      for (const token of drivers.sectionTokens[section]) {
        expect(drivers.tokenSections[token], `${token} → sections`).toContain(section)
      }
    }
  })

  it('is consistent in the reverse direction: tokenSections only lists real sections', () => {
    for (const [token, sections] of Object.entries(drivers.tokenSections)) {
      expect(token).toMatch(TOKEN_NAME)
      expect(sections.length).toBeGreaterThan(0)
      for (const section of sections) {
        expect(SECTION_DRIVERS[section as SpecimenSectionId]).toContain(token)
      }
    }
  })

  it('is deterministic: repeated calls return deep-equal registries', () => {
    expect(tokenDrivers()).toEqual(drivers)
  })
})
