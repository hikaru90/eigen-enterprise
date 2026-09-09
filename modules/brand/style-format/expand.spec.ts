import { wcagContrast } from 'culori'
import { describe, expect, it } from 'vitest'
import { expandSeeds, utopiaClamp } from './expand'
import { validSeeds } from './seeds.spec'

describe('utopiaClamp', () => {
  it('computes the CSS-lock clamp formula', () => {
    // slope = (24-16)/(1200-400) = 0.01 px/px; intercept = 16 - 0.01*400 = 12px
    expect(utopiaClamp(16, 24, 400, 1200)).toBe('clamp(1rem, 0.75rem + 0.0625vw, 1.5rem)')
  })

  it('resolves exactly to min at vpMin and max at vpMax', () => {
    // at 400px: 0.75rem + 0.0625vw*400/16... 12px + 0.01*400 = 16px = min ✓
    // at 1200px: 12px + 0.01*1200 = 24px = max ✓
    const css = utopiaClamp(16, 24, 400, 1200)
    expect(css).toContain('clamp(1rem')
    expect(css).toContain('1.5rem)')
  })

  it('handles fractional results deterministically', () => {
    expect(utopiaClamp(15, 17.5, 375, 1280)).toBe(
      'clamp(0.9375rem, 0.8728rem + 0.0173vw, 1.0938rem)',
    )
  })
})

describe('expandSeeds — invariants', () => {
  const expanded = expandSeeds(validSeeds())

  it('is deterministic across runs', () => {
    expect(expandSeeds(validSeeds())).toEqual(expandSeeds(validSeeds()))
  })

  it('throws loud for m3-scheme (not implemented in v0)', () => {
    expect(() => expandSeeds(validSeeds({ darkModeStrategy: 'm3-scheme' }))).toThrow(
      /m3-scheme.*not implemented in v0/,
    )
  })

  it('covers the shadcn roles layout.css consumes', () => {
    const expectedRoles = [
      '--background',
      '--foreground',
      '--card',
      '--card-foreground',
      '--popover',
      '--popover-foreground',
      '--primary',
      '--primary-foreground',
      '--secondary',
      '--secondary-foreground',
      '--muted',
      '--muted-foreground',
      '--accent',
      '--accent-foreground',
      '--destructive',
      '--border',
      '--input',
      '--ring',
      '--chart-1',
      '--chart-2',
      '--chart-3',
      '--chart-4',
      '--chart-5',
      '--radius',
      '--radius-sm',
      '--radius-md',
      '--radius-lg',
      '--radius-xl',
      '--radius-2xl',
      '--radius-3xl',
      '--radius-4xl',
    ]
    // invert-tone re-anchors color only — type/space/shape/motion/grain are
    // mode-independent and stay in the light set (same shape as `.dark {}` in layout.css).
    const modeIndependent = ['--radius', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-3xl', '--radius-4xl']
    for (const role of expectedRoles.filter((r) => !modeIndependent.includes(r))) {
      expect(expanded.darkCssVars[role], `dark ${role}`).toBeTruthy()
    }
    expect(Object.keys(expanded.darkCssVars).every((k) => !k.startsWith('--text-'))).toBe(true)
  })

  it('emits oklch() strings with 12-step ramps behind the roles', () => {
    for (const key of Object.keys(expanded.cssVars)) {
      if (key.startsWith('--chart') || key.startsWith('--radius') || key.startsWith('--text') ||
          key.startsWith('--space') || key.startsWith('--shadow') || key.startsWith('--duration') ||
          key.startsWith('--ease') || key.startsWith('--font') || key.startsWith('--grain')) {
        continue
      }
      expect(expanded.cssVars[key], key).toMatch(/^oklch\([\d. ]+\)$/)
    }
  })

  it('inverts light mode into dark monotonically (bg darkest, fg lightest)', () => {
    const l = (s: string) => Number(s.replace(/^oklch\(([\d.]+) .+$/, '$1'))
    const bgL = l(expanded.darkCssVars['--background'])
    const fgL = l(expanded.darkCssVars['--foreground'])
    const cardL = l(expanded.darkCssVars['--card'])
    expect(bgL).toBeLessThan(cardL)
    expect(cardL).toBeLessThan(fgL)
    // the dark background is the exact inversion anchor of the light background step
    expect(bgL).toBeCloseTo(0.13, 2)
    // same hue family in both modes
    const h = (s: string) => Number(s.replace(/^oklch\([\d.]+ [\d.]+ ([\d.]+)\)$/, '$1'))
    expect(h(expanded.darkCssVars['--primary'])).toBeCloseTo(
      h(expanded.cssVars['--primary']),
      0,
    )
  })

  it('keeps text ramps WCAG-readable against the background in both modes', () => {
    for (const [mode, vars] of [
      ['light', expanded.cssVars],
      ['dark', expanded.darkCssVars],
    ] as const) {
      const ratio = wcagContrast(vars['--foreground'], vars['--background'])
      expect(ratio, `${mode} foreground contrast`).toBeGreaterThanOrEqual(4.5)
      expect(wcagContrast(vars['--muted-foreground'], vars['--background'])).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('derives five chart hues stepping by accentHueShift around the seed hue', () => {
    const h = (s: string) => Number(s.replace(/^oklch\([\d.]+ [\d.]+ ([\d.]+)\)$/, '$1'))
    expect(h(expanded.cssVars['--chart-1'])).toBeCloseTo(152, 0)
    expect(h(expanded.cssVars['--chart-3'])).toBeCloseTo(200, 0)
    expect(h(expanded.cssVars['--chart-5'])).toBeCloseTo(248, 0)
  })

  it('maps fonts by slot', () => {
    expect(expanded.fonts).toEqual({
      sans: 'Inter',
      display: 'UnifrakturMaguntia',
      mono: 'Geist Mono',
    })
    expect(expanded.cssVars['--font-sans']).toBe('"Inter"')
    expect(expanded.cssVars['--font-display']).toBe('"UnifrakturMaguntia"')
    expect(expanded.cssVars['--font-mono']).toBe('"Geist Mono"')
  })

  it('emits fluid type steps with line-height and tracking companions', () => {
    expect(expanded.cssVars['--text-step-0']).toBe('clamp(1rem, 0.9375rem + 0.0156vw, 1.125rem)')
    expect(expanded.cssVars['--text-step-4']).toBe('clamp(1.6018rem, 1.2363rem + 0.0914vw, 2.3328rem)')
    expect(expanded.cssVars['--text-step-0-lh']).toBe('1.5')
    expect(expanded.cssVars['--text-step-4-lh']).toBe('1.3')
    expect(expanded.cssVars['--text-step-0-tracking']).toBe('-0.015em')
    expect(expanded.cssVars['--text-step-4-tracking']).toBe('-0.035em')
  })

  it('emits space tokens as fluid clamps of the rhythm multipliers', () => {
    expect(expanded.cssVars['--space-1']).toBe('clamp(0.25rem, 0.2344rem + 0.0039vw, 0.2813rem)')
    expect(expanded.cssVars['--space-5']).toBe('clamp(2rem, 1.875rem + 0.0313vw, 2.25rem)')
    expect(Object.keys(expanded.cssVars).filter((k) => k.startsWith('--space-'))).toHaveLength(5)
  })

  describe('shapeCharacter table', () => {
    it('sharp zeroes every derived radius', () => {
      const { cssVars } = expandSeeds(validSeeds({ shapeCharacter: 'sharp' }))
      expect(cssVars['--radius']).toBe('0.5rem')
      expect(cssVars['--radius-sm']).toBe('0px')
      expect(cssVars['--radius-4xl']).toBe('0px')
    })

    it('soft scales the base radius by the pinned multiplier table', () => {
      const { cssVars } = expandSeeds(validSeeds({ shapeCharacter: 'soft' }))
      expect(cssVars['--radius-sm']).toBe('calc(var(--radius) * 0.6)')
      expect(cssVars['--radius-lg']).toBe('calc(var(--radius) * 1)')
      expect(cssVars['--radius-4xl']).toBe('calc(var(--radius) * 2.6)')
    })

    it('pill goes 999px on large steps only', () => {
      const { cssVars } = expandSeeds(validSeeds({ shapeCharacter: 'pill' }))
      expect(cssVars['--radius-lg']).toBe('calc(var(--radius) * 1)')
      expect(cssVars['--radius-xl']).toBe('999px')
      expect(cssVars['--radius-4xl']).toBe('999px')
    })

    it('squircle emits the soft values', () => {
      const soft = expandSeeds(validSeeds({ shapeCharacter: 'soft' })).cssVars
      const squircle = expandSeeds(validSeeds({ shapeCharacter: 'squircle' })).cssVars
      expect(squircle).toEqual(soft)
    })
  })

  describe('elevation table', () => {
    it('flat emits no shadow tokens', () => {
      const { cssVars } = expandSeeds(validSeeds({ elevation: 'flat' }))
      expect(Object.keys(cssVars).filter((k) => k.startsWith('--shadow-'))).toHaveLength(0)
    })

    it('subtle and layered emit three tokens with the pinned recipes', () => {
      const subtle = expandSeeds(validSeeds({ elevation: 'subtle' })).cssVars
      expect(subtle['--shadow-1']).toBe('0 1px 2px oklch(0.15 0.02 152 / 0.05)')
      expect(subtle['--shadow-3']).toBe('0 4px 8px oklch(0.15 0.02 152 / 0.1)')
      const layered = expandSeeds(validSeeds({ elevation: 'layered' })).cssVars
      expect(layered['--shadow-2']).toBe('0 4px 12px oklch(0.15 0.02 152 / 0.12)')
      expect(layered['--shadow-3']).toBe('0 12px 32px oklch(0.15 0.02 152 / 0.18)')
    })
  })

  describe('motionPersonality table', () => {
    it('productive pins 150/300ms with standard ease curves', () => {
      const { cssVars } = expandSeeds(validSeeds({ motionPersonality: 'productive' }))
      expect(cssVars['--duration-fast']).toBe('150ms')
      expect(cssVars['--duration-slow']).toBe('300ms')
      expect(cssVars['--ease-enter']).toBe('cubic-bezier(0, 0, 0.2, 1)')
      expect(cssVars['--ease-exit']).toBe('cubic-bezier(0.4, 0, 1, 1)')
    })

    it('expressive pins 250/500ms with expressive curves', () => {
      const { cssVars } = expandSeeds(validSeeds({ motionPersonality: 'expressive' }))
      expect(cssVars['--duration-fast']).toBe('250ms')
      expect(cssVars['--duration-slow']).toBe('500ms')
      expect(cssVars['--ease-enter']).toBe('cubic-bezier(0.05, 0.7, 0.1, 1)')
      expect(cssVars['--ease-exit']).toBe('cubic-bezier(0.3, 0, 0.8, 0.15)')
    })
  })

  describe('grain', () => {
    it('emits no grain tokens at 0', () => {
      const { cssVars } = expandSeeds(validSeeds({ grain: 0 }))
      expect(Object.keys(cssVars).filter((k) => k.startsWith('--grain-'))).toHaveLength(0)
    })

    it('emits the fixed-seed turbulence data-uri plus opacity above 0', () => {
      const { cssVars } = expandSeeds(validSeeds({ grain: 0.06 }))
      expect(cssVars['--grain-image']).toContain("seed='42'")
      expect(cssVars['--grain-image']).toContain('data:image/svg+xml')
      expect(cssVars['--grain-opacity']).toBe('0.06')
    })
  })

  it('chromaCurve changes the ramp character', () => {
    const c = (s: string) => Number(s.replace(/^oklch\([\d.]+ ([\d.]+) .+$/, '$1'))
    const flat = expandSeeds(validSeeds({ chromaCurve: 'flat' })).cssVars
    const muted = expandSeeds(validSeeds({ chromaCurve: 'muted' })).cssVars
    const tailwind = expandSeeds(validSeeds()).cssVars
    expect(c(flat['--primary'])).toBeCloseTo(0.14, 3)
    expect(c(muted['--primary'])).toBeCloseTo(0.063, 3)
    expect(c(tailwind['--primary'])).toBeCloseTo(0.1288, 3)
  })
})

describe('expandSeeds — golden snapshot (V3: expand(seed) === tokens.json)', () => {
  // The canonical seed block. Every pinned expansion rule (Radix ladder,
  // invert-tone dark, Utopia clamps, shape/elevation/motion tables, grain)
  // is frozen by this snapshot — any change to expand() must consciously
  // update the golden file, never drift silently.
  it('expands the canonical seed to byte-identical tokens', () => {
    expect(expandSeeds(validSeeds())).toMatchSnapshot()
  })

  it('expands a second axis seed (pill/layered/expressive/grain) to byte-identical tokens', () => {
    expect(
      expandSeeds(
        validSeeds({
          shapeCharacter: 'pill',
          radiusBase: '999px',
          elevation: 'layered',
          motionPersonality: 'expressive',
          grain: 0.08,
        }),
      ),
    ).toMatchSnapshot()
  })
})
