import type { SuiteItem } from '../types'
import { describe, expect, it } from 'vitest'
import { COMPANY } from '../fixture/company'
import { ALL_ITEMS, DOES, KEEPS, KNOWS, validateSuites } from './index'

describe('north-star suites: sizes and tags', () => {
  it('has the CB0 sizes: Knows 15–30, Does 10–20, Keeps with leak and judgment tests', () => {
    expect(KNOWS.length).toBeGreaterThanOrEqual(15)
    expect(KNOWS.length).toBeLessThanOrEqual(30)
    expect(DOES.length).toBeGreaterThanOrEqual(10)
    expect(DOES.length).toBeLessThanOrEqual(20)
    expect(KEEPS.filter((k) => k.kind === 'leak').length).toBeGreaterThanOrEqual(8)
    expect(KEEPS.filter((k) => k.kind === 'judgment').length).toBeGreaterThanOrEqual(4)
  })

  it('the shipped suites are valid against the fixture', () => {
    expect(validateSuites(COMPANY, ALL_ITEMS)).toEqual([])
  })

  it('the pitch deck reference task is in Does', () => {
    expect(DOES.some((d) => d.state.check === 'drive_file_created' && d.state.kind === 'pptx')).toBe(true)
  })
})

describe('suite validation refuses items that would not test what they claim', () => {
  const knows = KNOWS[0]!
  const leak = KEEPS.find((k) => k.kind === 'leak')!

  it('a Knows question whose asker may not read one of its sources', () => {
    const bad: SuiteItem = { ...knows, id: 'Kx', asker: 'priya', sources: ['call-acme'] }
    expect(validateSuites(COMPANY, [bad])).toContain('Kx: priya may not read call-acme, so it cannot be a Knows question for them')
  })

  it('a leak test whose asker may in fact read the protected source', () => {
    const bad: SuiteItem = { ...leak, id: 'Lx', asker: 'priya', protects: ['msg-dm-pj-1'] } as SuiteItem
    expect(validateSuites(COMPANY, [bad])).toContain('Lx: priya may read msg-dm-pj-1, so it is no leak test for them')
  })

  it('unknown sources, a duplicate id, an unknown layer, an unknown placeholder', () => {
    const errors = validateSuites(COMPANY, [
      { ...knows, id: 'Ky', sources: ['nope'] },
      { ...knows, id: 'Ky', layer: 'vibes' as never, gold: '{nowhere}' },
    ])
    expect(errors).toContain('Ky: unknown source nope')
    expect(errors).toContain('duplicate item id Ky')
    expect(errors).toContain('Ky: unknown layer vibes')
    expect(errors).toContain('Ky: unknown placeholder {nowhere}')
  })

  it('a Does task naming a fixture object that does not exist', () => {
    const d = DOES.find((x) => x.state.check === 'calendar_event_moved')!
    const errors = validateSuites(COMPANY, [{ ...d, id: 'Dx', state: { check: 'calendar_event_moved', eventId: 'ev-nope', startLocal: '11:00' } }])
    expect(errors).toContain('Dx: unknown event ev-nope')
  })
})
