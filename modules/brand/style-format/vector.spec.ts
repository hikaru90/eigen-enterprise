import type { BrandCorpusItem } from './corpus'
import { describe, expect, it } from 'vitest'
import { classifyFontFamily, FONT_CLASS_DISTANCE } from './fonts'
import { brandSeedsSchema } from './seeds'
import { oklabDistance, styleDistance, styleVector, VECTOR_ROLES, type StyleVector } from './vector'

function seeds(overrides: Partial<Record<string, unknown>> = {}) {
  return brandSeedsSchema.parse({
    seedColor: { l: 0.55, c: 0.14, h: 152 },
    neutralTintHue: 152,
    accentHueShift: null,
    chromaCurve: 'muted',
    darkModeStrategy: 'invert-tone',
    fonts: { fontPrimary: 'Inter', fontSecondary: 'Lora', fontMono: 'Geist Mono' },
    fluidScale: {
      baseSize: { min: 16, max: 18 },
      scaleRatio: { min: 1.125, max: 1.2 },
      viewport: { min: 400, max: 1200 },
      scaleSteps: 4,
      trackingCurve: 'neutral',
    },
    spaceRhythm: [0.25, 0.5, 1, 2],
    shapeCharacter: 'soft',
    radiusBase: '0.5rem',
    elevation: 'flat',
    motionPersonality: 'productive',
    grain: 0,
    ...overrides,
  })
}

function item(overrides: Partial<BrandCorpusItem> = {}): BrandCorpusItem {
  return {
    id: '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f',
    name: 'toy',
    seeds: seeds(),
    cssVars: {
      '--background': 'oklch(0.985 0.005 152)',
      '--foreground': 'oklch(0.247 0.005 152)',
      '--primary': 'oklch(0.536 0.14 152)',
      '--secondary': 'oklch(0.853 0.05 152)',
      '--accent': 'oklch(0.853 0.05 152)',
      '--muted': 'oklch(0.931 0.005 152)',
      '--border': 'oklch(0.697 0.005 152)',
      '--ring': 'oklch(0.615 0.12 152)',
      '--card': 'oklch(0.985 0.005 152)',
      '--destructive': 'oklch(0.536 0.2 27)',
      '--radius': '0.5rem',
      '--space-1': 'clamp(0.25rem, 0.2rem + 0.025vw, 0.3rem)',
      '--font-sans': '"Inter"',
      '--font-display': '"Lora"',
      '--font-mono': '"Geist Mono"',
    },
    darkCssVars: { '--background': 'oklch(0.13 0.005 152)' },
    provenance: { source: 'archetype' },
    createdAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  }
}

const MONO_TERMINAL = item({
  name: 'mono-terminal',
  seeds: seeds({
    seedColor: { l: 0.7, c: 0.02, h: 145 },
    fonts: { fontPrimary: 'JetBrains Mono', fontSecondary: 'JetBrains Mono', fontMono: 'JetBrains Mono' },
    radiusBase: '0px',
    shapeCharacter: 'sharp',
  }),
  cssVars: {
    '--background': 'oklch(0.985 0.005 145)',
    '--foreground': 'oklch(0.247 0.005 145)',
    '--primary': 'oklch(0.536 0.02 145)',
    '--secondary': 'oklch(0.853 0.01 145)',
    '--accent': 'oklch(0.853 0.01 145)',
    '--muted': 'oklch(0.931 0.005 145)',
    '--border': 'oklch(0.697 0.005 145)',
    '--ring': 'oklch(0.615 0.02 145)',
    '--card': 'oklch(0.985 0.005 145)',
    '--destructive': 'oklch(0.536 0.2 27)',
    '--radius': '0px',
    '--space-1': 'clamp(0.25rem, 0.2rem + 0.025vw, 0.3rem)',
    '--font-sans': '"JetBrains Mono"',
    '--font-display': '"JetBrains Mono"',
    '--font-mono': '"JetBrains Mono"',
  },
})

const PASTEL_SOFT = item({
  name: 'pastel-soft',
  seeds: seeds({ seedColor: { l: 0.75, c: 0.06, h: 300 }, radiusBase: '0.75rem' }),
  cssVars: {
    ...item().cssVars,
    '--primary': 'oklch(0.75 0.06 300)',
    '--secondary': 'oklch(0.9 0.03 310)',
    '--accent': 'oklch(0.9 0.03 310)',
    '--ring': 'oklch(0.75 0.05 300)',
    '--radius': '0.75rem',
  },
})

const PASTEL_SIBLING = item({
  name: 'pastel-sibling',
  id: '1b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f',
  seeds: seeds({ seedColor: { l: 0.75, c: 0.07, h: 320 }, radiusBase: '0.75rem' }),
  cssVars: {
    ...item().cssVars,
    '--primary': 'oklch(0.75 0.07 320)',
    '--secondary': 'oklch(0.9 0.03 310)',
    '--accent': 'oklch(0.9 0.03 310)',
    '--ring': 'oklch(0.75 0.06 320)',
    '--radius': '0.75rem',
  },
})

describe('classifyFontFamily', () => {
  it('classifies by exact table lookup', () => {
    expect(classifyFontFamily('Inter')).toBe('sans')
    expect(classifyFontFamily('Lora')).toBe('serif')
    expect(classifyFontFamily('JetBrains Mono')).toBe('mono')
    expect(classifyFontFamily('Space Grotesk')).toBe('display')
  })

  it('throws loud on unknown families instead of guessing', () => {
    expect(() => classifyFontFamily('Comic Sans Pro')).toThrow(/FONT_CLASS_TABLE/)
  })

  it('has a symmetric distance matrix with zero diagonal', () => {
    const classes = ['sans', 'serif', 'mono', 'display'] as const
    for (const a of classes) {
      expect(FONT_CLASS_DISTANCE[a][a]).toBe(0)
      for (const b of classes) {
        expect(FONT_CLASS_DISTANCE[a][b]).toBe(FONT_CLASS_DISTANCE[b][a])
      }
    }
  })
})

describe('styleVector', () => {
  it('extracts all 10 core color roles', () => {
    const v = styleVector(item())
    for (const role of VECTOR_ROLES) {
      expect(v.colors[role]).toBeDefined()
      expect(v.colors[role].l).toBeGreaterThan(0)
      expect(v.colors[role].l).toBeLessThanOrEqual(1)
    }
    expect(VECTOR_ROLES).toHaveLength(10)
  })

  it('throws loud listing missing roles', () => {
    const broken = item()
    const { '--primary': _drop, ...vars } = broken.cssVars
    expect(() => styleVector({ ...broken, cssVars: vars })).toThrow(/missing cssVar roles.*--primary/)
  })

  it('normalizes radius and spacing into 0..1', () => {
    const sharp = styleVector(MONO_TERMINAL)
    expect(sharp.radius).toBe(0)
    const soft = styleVector(item())
    expect(soft.radius).toBeCloseTo(0.25, 5) // 0.5rem / 2rem
    expect(soft.spacing).toBeGreaterThan(0)
    expect(soft.spacing).toBeLessThanOrEqual(1)
  })

  it('measures the light/dark background delta normalized to 0..1', () => {
    const v = styleVector(item())
    expect(v.darkDelta).toBeGreaterThan(0.5)
    expect(v.darkDelta).toBeLessThanOrEqual(1)
    const noDark = styleVector({ ...item(), darkCssVars: {} })
    expect(noDark.darkDelta).toBe(0)
  })

  it('classifies font slots categorically', () => {
    const v = styleVector(item())
    expect(v.fontClasses.sans).toBe('sans')
    expect(v.fontClasses.display).toBe('serif')
    expect(v.fontClasses.mono).toBe('mono')
  })

  it('derives spacing from seeds when cssVars carry no space scale', () => {
    const vars = { ...item().cssVars }
    delete vars['--space-1']
    const v = styleVector({ ...item(), cssVars: vars })
    // seeds: spaceRhythm[0]=0.25 × baseSize.min 16px / 16 = 0.25rem → 0.25/1.5
    expect(v.spacing).toBeCloseTo(0.25 / 1.5, 5)
  })
})

describe('styleDistance', () => {
  it('is symmetric and zero only against itself', () => {
    const a = styleVector(PASTEL_SOFT)
    const b = styleVector(PASTEL_SIBLING)
    const c = styleVector(MONO_TERMINAL)
    expect(styleDistance(a, a)).toBe(0)
    expect(styleDistance(a, b)).toBeCloseTo(styleDistance(b, a), 12)
    expect(styleDistance(a, c)).toBeCloseTo(styleDistance(c, a), 12)
  })

  it('is bounded to 0..1', () => {
    const a = styleVector(PASTEL_SOFT)
    const b = styleVector(MONO_TERMINAL)
    expect(styleDistance(a, b)).toBeGreaterThanOrEqual(0)
    expect(styleDistance(a, b)).toBeLessThanOrEqual(1)
  })

  it('is deterministic', () => {
    const a = styleVector(PASTEL_SOFT)
    const b = styleVector(MONO_TERMINAL)
    expect(styleDistance(a, b)).toBe(styleDistance(styleVector(PASTEL_SOFT), styleVector(MONO_TERMINAL)))
  })

  it('orders known styles: a pastel is closer to its pastel sibling than to a mono terminal', () => {
    const pastel = styleVector(PASTEL_SOFT)
    const pastelSibling = styleVector(PASTEL_SIBLING)
    const mono = styleVector(MONO_TERMINAL)
    expect(styleDistance(pastel, pastelSibling)).toBeLessThan(styleDistance(pastel, mono))
  })

  it('color share dominates and saturates at its 0.45 weight for opposed palettes', () => {
    // identical everything except a fully opposed palette (dark bg, inverted
    // text/accent) → color component clamps at 1 → distance ≈ 0.45 plus the
    // darkDelta effect share (inverted drops its dark variant).
    const base = styleVector(item())
    const inverted = styleVector(
      item({
        cssVars: {
          ...item().cssVars,
          '--background': 'oklch(0.13 0.005 152)',
          '--foreground': 'oklch(0.985 0.005 152)',
          '--primary': 'oklch(0.4 0.14 332)',
          '--secondary': 'oklch(0.15 0.05 152)',
          '--accent': 'oklch(0.15 0.05 152)',
          '--muted': 'oklch(0.2 0.005 152)',
          '--border': 'oklch(0.3 0.005 152)',
          '--ring': 'oklch(0.3 0.12 152)',
          '--card': 'oklch(0.13 0.005 152)',
        },
        darkCssVars: {},
      }),
    )
    const d = styleDistance(base, inverted)
    expect(d).toBeGreaterThan(0.45)
    expect(d).toBeLessThanOrEqual(0.5)
  })
})

describe('oklabDistance', () => {
  it('is 0 for identical colors and larger for distant ones', () => {
    const white = { l: 1, c: 0, h: 0 }
    const black = { l: 0, c: 0, h: 0 }
    expect(oklabDistance(white, white)).toBe(0)
    expect(oklabDistance(white, black)).toBeCloseTo(1, 5)
    expect(oklabDistance(white, black)).toBeGreaterThan(oklabDistance(white, { l: 0.8, c: 0.02, h: 200 }))
  })
})

describe('vector emit', () => {
  it('has a fixed numeric layout with documented dimensions', async () => {
    const { toNumericVector, NUMERIC_DIMS } = await import('./vector')
    const v: StyleVector = styleVector(item())
    expect(toNumericVector(v)).toHaveLength(NUMERIC_DIMS)
    expect(NUMERIC_DIMS).toBe(48) // 30 color + radius + spacing + 12 font one-hot + 4 scalars
    for (const x of toNumericVector(v)) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
    }
  })
})
