import { describe, expect, it } from 'vitest'
import { digestFacts, normalizeColor, type ElementFacts, type SiteFacts } from './facts-digest'

function elementFacts(overrides: Partial<ElementFacts> = {}): ElementFacts {
  return {
    color: 'rgb(17, 17, 17)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    fontFamily: '"Inter", sans-serif',
    fontSize: '16px',
    fontWeight: '400',
    lineHeight: '24px',
    letterSpacing: 'normal',
    borderRadius: '0px',
    boxShadow: 'none',
    borderWidth: '0px',
    borderStyle: 'none',
    padding: '0px',
    margin: '0px',
    ...overrides,
  }
}

function siteFacts(overrides: Partial<SiteFacts> = {}): SiteFacts {
  return {
    selectors: {
      body: [elementFacts()],
      h1: [elementFacts({ fontSize: '40px', fontWeight: '700' })],
      button: [
        elementFacts({ backgroundColor: 'rgb(34, 232, 118)', borderRadius: '8px', padding: '12px 16px' }),
        elementFacts({ backgroundColor: 'rgb(34, 232, 118)', borderRadius: '8px', padding: '12px 16px' }),
      ],
    },
    themeColor: '#e8ede5',
    title: 'Kindred Digital Labs',
    colorCensus: [
      { color: '#22e876', count: 9 },
      { color: '#111111', count: 4 },
    ],
    ...overrides,
  }
}

describe('normalizeColor', () => {
  it('folds opaque rgb into hex', () => {
    expect(normalizeColor('rgb(17, 17, 17)')).toBe('#111111')
    expect(normalizeColor('rgb(255, 255, 255)')).toBe('#ffffff')
  })

  it('keeps alpha in rgba form', () => {
    expect(normalizeColor('rgba(17, 17, 17, 0.5)')).toBe('rgba(17, 17, 17, 0.5)')
  })

  it('normalizes oklch spacing and keeps it verbatim', () => {
    expect(normalizeColor('oklch(0.55 0.14 152)')).toBe('oklch(0.55 0.14 152)')
    expect(normalizeColor('oklch(0.55 0.14 152 / 0.5)')).toBe('oklch(0.55 0.14 152 / 0.5)')
  })

  it('passes through transparent and unknown tokens', () => {
    expect(normalizeColor('transparent')).toBe('transparent')
  })
})

describe('digestFacts', () => {
  const digest = digestFacts(siteFacts())

  it('leads with the title and theme color', () => {
    expect(digest).toContain('SITE: Kindred Digital Labs')
    expect(digest).toContain('THEME-COLOR: #e8ede5')
  })

  it('ranks the color census by frequency', () => {
    expect(digest).toContain('#22e876 (9)')
    expect(digest).toContain('#111111 (4)')
    expect(digest.indexOf('#22e876 (9)')).toBeLessThan(digest.indexOf('#111111 (4)'))
  })

  it('summarizes typography per selector', () => {
    expect(digest).toContain('TYPE body:')
    expect(digest).toContain('"Inter", sans-serif')
    expect(digest).toContain('TYPE h1:')
  })

  it('summarizes radii, spacing, shadows and borders with counts', () => {
    expect(digest).toContain('RADII: 0px (2), 8px (2)')
    expect(digest).toContain('PADDING: 0px (2), 12px 16px (2)')
    expect(digest).toContain('BORDERS: 0px none (4)')
  })

  it('caps the color census at 15 entries', () => {
    const colors = Array.from({ length: 30 }, (_, i) => ({
      color: `#${String(i).padStart(6, '0')}`,
      count: 30 - i,
    }))
    const big = digestFacts(siteFacts({ colorCensus: colors }))
    const censusLine = big.split('\n').find((l) => l.startsWith('COLORS'))
    expect(censusLine).toBeTruthy()
    const entries = censusLine!.slice(censusLine!.indexOf('): ') + 3).split(', ')
    expect(entries).toHaveLength(15)
  })

  it('is deterministic', () => {
    expect(digestFacts(siteFacts())).toBe(digest)
  })
})
