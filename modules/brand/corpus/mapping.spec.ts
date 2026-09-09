import { describe, expect, it } from 'vitest'
import { classifyFontFamily } from '../style-format/fonts'
import {
  BUILD_EPOCH,
  corpusSlug,
  daisyUiThemeToItem,
  deriveSeedsFromShadcnVars,
  deterministicUuid,
  firstNamedFamily,
  mapDaisyUiVarsToShadcn,
  parseDaisyUiThemeCss,
  substituteOflFont,
  TIER1_DEFAULT_FONTS,
  tweakcnPresetToItem,
} from './mapping'

const DAISY_CUPCAKE_CSS = `[data-theme="cupcake"] {
color-scheme: light;
--color-base-100: oklch(97.788% 0.004 56.375);
--color-base-200: oklch(93.982% 0.007 61.449);
--color-base-300: oklch(91.586% 0.006 53.44);
--color-base-content: oklch(23.574% 0.066 313.189);
--color-primary: oklch(85% 0.138 181.071);
--color-primary-content: oklch(43% 0.078 188.216);
--color-secondary: oklch(89% 0.061 343.231);
--color-secondary-content: oklch(45% 0.187 3.815);
--color-accent: oklch(90% 0.076 70.697);
--color-accent-content: oklch(47% 0.157 37.304);
--color-neutral: oklch(27% 0.006 286.033);
--color-neutral-content: oklch(92% 0.004 286.32);
--color-info: oklch(68% 0.169 237.323);
--color-success: oklch(69% 0.17 162.48);
--color-warning: oklch(79% 0.184 86.047);
--color-error: oklch(64% 0.246 16.439);
--color-error-content: oklch(27% 0.105 12.094);
--radius-selector: 1rem;
--radius-field: 2rem;
--radius-box: 1rem;
--size-selector: 0.25rem;
--size-field: 0.25rem;
--border: 2px;
--depth: 1;
--noise: 0;
}`

const TWEAKCN_FIXTURE = {
  name: 'vercel',
  title: 'Vercel',
  cssVars: {
    theme: {
      'font-sans': 'Inter, sans-serif',
      'font-serif': 'Source Serif 4, serif',
      'font-mono': 'JetBrains Mono, monospace',
      radius: '0.5rem',
      'tracking-normal': '-0.015em',
    },
    light: {
      background: 'oklch(1.00 0 0)',
      foreground: 'oklch(0.20 0 0)',
      card: 'oklch(1.00 0 0)',
      'card-foreground': 'oklch(0.20 0 0)',
      popover: 'oklch(1.00 0 0)',
      'popover-foreground': 'oklch(0.20 0 0)',
      primary: 'oklch(0.20 0 0)',
      'primary-foreground': 'oklch(1.00 0 0)',
      secondary: 'oklch(0.96 0 0)',
      'secondary-foreground': 'oklch(0.20 0 0)',
      muted: 'oklch(0.96 0 0)',
      'muted-foreground': 'oklch(0.55 0 0)',
      accent: 'oklch(0.96 0 0)',
      'accent-foreground': 'oklch(0.20 0 0)',
      destructive: 'oklch(0.60 0.22 27)',
      'destructive-foreground': 'oklch(1.00 0 0)',
      border: 'oklch(0.92 0 0)',
      input: 'oklch(0.92 0 0)',
      ring: 'oklch(0.20 0 0)',
    },
    dark: {
      background: 'oklch(0.14 0 0)',
      foreground: 'oklch(0.98 0 0)',
      card: 'oklch(0.18 0 0)',
      'card-foreground': 'oklch(0.98 0 0)',
      popover: 'oklch(0.18 0 0)',
      'popover-foreground': 'oklch(0.98 0 0)',
      primary: 'oklch(0.98 0 0)',
      'primary-foreground': 'oklch(0.20 0 0)',
      secondary: 'oklch(0.26 0 0)',
      'secondary-foreground': 'oklch(0.98 0 0)',
      muted: 'oklch(0.26 0 0)',
      'muted-foreground': 'oklch(0.70 0 0)',
      accent: 'oklch(0.26 0 0)',
      'accent-foreground': 'oklch(0.98 0 0)',
      destructive: 'oklch(0.65 0.20 27)',
      'destructive-foreground': 'oklch(0.98 0 0)',
      border: 'oklch(0.30 0 0)',
      input: 'oklch(0.30 0 0)',
      ring: 'oklch(0.98 0 0)',
    },
  },
}

describe('deterministicUuid / corpusSlug', () => {
  it('derives stable uuids from the slug', () => {
    expect(deterministicUuid('daisyui-cupcake')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(deterministicUuid('daisyui-cupcake')).toBe(deterministicUuid('daisyui-cupcake'))
    expect(deterministicUuid('daisyui-cupcake')).not.toBe(deterministicUuid('daisyui-cupcake-x'))
  })

  it('slugifies source + name deterministically', () => {
    expect(corpusSlug('daisyui', 'Cupcake')).toBe('daisyui-cupcake')
    expect(corpusSlug('tweakcn', 'Neo Brutalism')).toBe('tweakcn-neo-brutalism')
    expect(() => corpusSlug('daisyui', '///')).toThrow(/slugify/)
  })
})

describe('parseDaisyUiThemeCss', () => {
  it('parses scheme + custom properties from a per-theme file', () => {
    const { scheme, vars } = parseDaisyUiThemeCss(DAISY_CUPCAKE_CSS, 'cupcake')
    expect(scheme).toBe('light')
    expect(vars['--color-primary']).toBe('oklch(85% 0.138 181.071)')
    expect(vars['--radius-field']).toBe('2rem')
    expect(vars['--depth']).toBe('1')
  })

  it('throws loud on garbage input', () => {
    expect(() => parseDaisyUiThemeCss('no block here', 'x')).toThrow(/no CSS block/)
    expect(() => parseDaisyUiThemeCss('.a { color: red }', 'x')).toThrow(/color-scheme/)
  })
})

describe('mapDaisyUiVarsToShadcn', () => {
  const mapped = mapDaisyUiVarsToShadcn(parseDaisyUiThemeCss(DAISY_CUPCAKE_CSS, 'cupcake').vars, 'cupcake')

  it('maps the documented daisyUI -> shadcn table', () => {
    expect(mapped['--background']).toBe('oklch(97.788% 0.004 56.375)') // base-100
    expect(mapped['--popover']).toBe('oklch(97.788% 0.004 56.375)') // base-100
    expect(mapped['--card']).toBe('oklch(93.982% 0.007 61.449)') // base-200
    expect(mapped['--border']).toBe('oklch(91.586% 0.006 53.44)') // base-300
    expect(mapped['--input']).toBe('oklch(91.586% 0.006 53.44)') // base-300
    expect(mapped['--foreground']).toBe('oklch(23.574% 0.066 313.189)') // base-content
    expect(mapped['--primary']).toBe('oklch(85% 0.138 181.071)')
    expect(mapped['--primary-foreground']).toBe('oklch(43% 0.078 188.216)')
    expect(mapped['--secondary']).toBe('oklch(89% 0.061 343.231)')
    expect(mapped['--accent']).toBe('oklch(90% 0.076 70.697)')
    expect(mapped['--muted']).toBe('oklch(27% 0.006 286.033)') // neutral
    expect(mapped['--destructive']).toBe('oklch(64% 0.246 16.439)') // error
    expect(mapped['--destructive-foreground']).toBe('oklch(27% 0.105 12.094)')
    expect(mapped['--ring']).toBe('oklch(85% 0.138 181.071)') // derived: ring = primary
    expect(mapped['--radius']).toBe('2rem') // derived: radius-field
    expect(mapped['--font-sans']).toBe('"Inter"') // derived: pinned OFL defaults (daisyUI v5 themes have no fonts)
    expect(mapped['--font-display']).toBe('"Source Serif 4"')
    expect(mapped['--font-mono']).toBe('"JetBrains Mono"')
  })

  it('derives muted-foreground as mid-band base-content (readable secondary text)', () => {
    // base-content L=0.2357 clamps up into the 0.35..0.65 band
    expect(mapped['--muted-foreground']).toBe('oklch(0.35 0.066 313.19)')
  })

  it('covers every shadcn role the vector math requires', () => {
    const roles = [
      'background', 'foreground', 'primary', 'secondary', 'accent',
      'muted', 'border', 'ring', 'card', 'destructive',
    ]
    for (const role of roles) expect(mapped[`--${role}`]).toBeDefined()
  })

  it('throws loud listing missing daisyUI vars', () => {
    expect(() => mapDaisyUiVarsToShadcn({ '--color-base-100': 'oklch(1 0 0)' }, 'broken')).toThrow(/missing vars.*--color-primary/)
  })
})

describe('deriveSeedsFromShadcnVars', () => {
  it('picks the most-chromatic accent role as seedColor (tie: primary first)', () => {
    const seeds = deriveSeedsFromShadcnVars({
      cssVars: {
        '--primary': 'oklch(0.6 0.1 200)',
        '--secondary': 'oklch(0.7 0.2 100)',
        '--accent': 'oklch(0.7 0.05 300)',
        '--muted': 'oklch(0.9 0.01 200)',
        '--radius': '0.5rem',
      },
    })
    expect(seeds.seedColor).toEqual({ l: 0.7, c: 0.2, h: 100 })
  })

  it('classifies chroma curves: muted / flat / tailwind', () => {
    const base = { '--primary': 'oklch(0.6 0.03 200)', '--secondary': 'oklch(0.7 0.03 100)', '--accent': 'oklch(0.7 0.04 300)', '--muted': 'oklch(0.9 0.01 200)', '--radius': '0.5rem' }
    expect(deriveSeedsFromShadcnVars({ cssVars: base }).chromaCurve).toBe('muted')
    // similar chromas ≥ 0.06 -> flat
    const flat = { ...base, '--primary': 'oklch(0.6 0.15 200)', '--secondary': 'oklch(0.7 0.13 100)', '--accent': 'oklch(0.7 0.16 300)' }
    expect(deriveSeedsFromShadcnVars({ cssVars: flat }).chromaCurve).toBe('flat')
    // strong chroma spread -> tailwind
    expect(deriveSeedsFromShadcnVars({ cssVars: { ...flat, '--secondary': 'oklch(0.7 0.02 100)' } }).chromaCurve).toBe('tailwind')
  })

  it('maps radius to shapeCharacter thresholds', () => {
    const mk = (radius) => deriveSeedsFromShadcnVars({ cssVars: { '--primary': 'oklch(0.6 0.1 200)', '--secondary': 'oklch(0.6 0.1 200)', '--accent': 'oklch(0.6 0.1 200)', '--muted': 'oklch(0.9 0 200)', '--radius': radius } })
    expect(mk('0rem').shapeCharacter).toBe('sharp')
    expect(mk('0.5rem').shapeCharacter).toBe('soft')
    expect(mk('2rem').shapeCharacter).toBe('pill')
  })

  it('uses pinned OFL defaults when the source names no fonts', () => {
    const seeds = deriveSeedsFromShadcnVars({ cssVars: { '--primary': 'oklch(0.6 0.1 200)', '--secondary': 'oklch(0.6 0.1 200)', '--accent': 'oklch(0.6 0.1 200)', '--muted': 'oklch(0.9 0 200)', '--radius': '0.5rem' } })
    expect(seeds.fonts).toEqual(TIER1_DEFAULT_FONTS)
  })

  it('derives the tracking curve from the source tracking token', () => {
    const base = { '--primary': 'oklch(0.6 0.1 200)', '--secondary': 'oklch(0.6 0.1 200)', '--accent': 'oklch(0.6 0.1 200)', '--muted': 'oklch(0.9 0 200)', '--radius': '0.5rem' }
    expect(deriveSeedsFromShadcnVars({ cssVars: base, trackingEm: '-0.015em' }).fluidScale.trackingCurve).toBe('negative-on-display')
    expect(deriveSeedsFromShadcnVars({ cssVars: base, trackingEm: '0.02em' }).fluidScale.trackingCurve).toBe('positive-on-display')
    expect(deriveSeedsFromShadcnVars({ cssVars: base }).fluidScale.trackingCurve).toBe('neutral')
  })
})

describe('font substitution', () => {
  it('takes the first family from CSS font stacks', () => {
    expect(firstNamedFamily('Inter, sans-serif')).toBe('Inter')
    expect(firstNamedFamily('"Source Code Pro", monospace')).toBe('Source Code Pro')
    expect(firstNamedFamily('ui-sans-serif, system-ui, sans-serif')).toBe('ui-sans-serif')
  })

  it('substitutes system/non-OFL families with pinned OFL families', () => {
    expect(substituteOflFont('ui-sans-serif')).toBe('Inter')
    expect(substituteOflFont('Georgia')).toBe('Source Serif 4')
    expect(substituteOflFont('Menlo')).toBe('JetBrains Mono')
    expect(substituteOflFont('monospace')).toBe('JetBrains Mono')
  })

  it('throws loud on unknown families', () => {
    expect(() => substituteOflFont('Comic Neue')).toThrow(/TIER1_FONT_SUBSTITUTES/)
  })

  it('only ever emits families the vector classifier knows', () => {
    for (const stack of ['Inter, sans-serif', 'ui-sans-serif, system-ui', 'ui-serif, Georgia', 'ui-monospace, Menlo']) {
      expect(() => classifyFontFamily(substituteOflFont(firstNamedFamily(stack)))).not.toThrow()
    }
  })
})

describe('daisyUiThemeToItem', () => {
  const item = daisyUiThemeToItem({ themeName: 'cupcake', cssText: DAISY_CUPCAKE_CSS, packageVersion: '5.7.28' })

  it('builds a tier1 item with slug-derived id and provenance', () => {
    expect(item.id).toBe(deterministicUuid('daisyui-cupcake'))
    expect(item.name).toBe('daisyUI Cupcake')
    expect(item.provenance.source).toBe('tier1')
    expect(item.provenance.url).toBe('https://daisyui.com/docs/themes/')
    expect(item.provenance.note).toBe('daisyUI theme: cupcake (daisyui@5.7.28)')
    expect(item.createdAt).toBe(BUILD_EPOCH)
    expect(item.darkCssVars).toEqual({})
  })

  it('derives seeds with cssVars as the vector source of truth', () => {
    expect(item.seeds.seedColor.c).toBeGreaterThan(0)
    expect(item.seeds.radiusBase).toBe('2rem')
    expect(item.seeds.shapeCharacter).toBe('pill') // radius-field 2rem
    expect(item.seeds.elevation).toBe('subtle') // --depth: 1
  })

  it('is deterministic', () => {
    const again = daisyUiThemeToItem({ themeName: 'cupcake', cssText: DAISY_CUPCAKE_CSS, packageVersion: '5.7.28' })
    expect(again).toEqual(item)
  })
})

describe('tweakcnPresetToItem', () => {
  const item = tweakcnPresetToItem(TWEAKCN_FIXTURE, 'https://raw.githubusercontent.com/jnsahaj/tweakcn/main/public/r/registry.json')

  it('maps registry cssVars straight through with -- prefixes and OFL-substituted fonts', () => {
    expect(item.cssVars['--background']).toBe('oklch(1.00 0 0)')
    expect(item.darkCssVars['--background']).toBe('oklch(0.14 0 0)')
    expect(item.cssVars['--radius']).toBe('0.5rem')
    expect(item.cssVars['--font-sans']).toBe('"Inter"')
  })

  it('derives seeds from named fonts + tracking', () => {
    expect(item.seeds.fonts).toEqual({ fontPrimary: 'Inter', fontSecondary: 'Source Serif 4', fontMono: 'JetBrains Mono' })
    expect(item.seeds.fluidScale.trackingCurve).toBe('negative-on-display')
    expect(item.seeds.shapeCharacter).toBe('soft')
  })

  it('carves provenance from the curated source url', () => {
    expect(item.provenance.source).toBe('tier1')
    expect(item.provenance.note).toBe('tweakcn preset: vercel')
    expect(item.id).toBe(deterministicUuid('tweakcn-vercel'))
  })

  it('throws loud per-item on missing data', () => {
    const broken = { name: 'broken', cssVars: { theme: {}, light: {}, dark: {} } }
    expect(() => tweakcnPresetToItem(broken, 'https://example.com')).toThrow(/tweakcn preset "broken"/)
  })
})
