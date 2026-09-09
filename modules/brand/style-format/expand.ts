import { wcagContrast, type Oklch } from 'culori'
import { brandSeedsSchema, type BrandSeeds } from './seeds'

/**
 * Deterministic seed -> design-system expansion (phase-2d M1). Every number is
 * pinned here in code; the same seeds always expand to byte-identical tokens.
 * Radix step semantics (1-2 app bg, 3-5 UI states, 6-8 borders, 9-10 solid,
 * 11-12 text) map onto the shadcn/Tailwind v4 roles used by src/routes/layout.css.
 */

// Light-mode OKLCH lightness anchors per ramp step (step 1 lightest .. step 12 darkest).
const LIGHT_LADDER = [0.985, 0.962, 0.931, 0.898, 0.853, 0.775, 0.697, 0.615, 0.536, 0.476, 0.373, 0.247]
const LIGHT_MAX = LIGHT_LADDER[0]
const LIGHT_MIN = LIGHT_LADDER[11]

// invert-tone dark re-anchor: bg endpoint -> 0.13, fg endpoint -> 0.96, linear in between.
const DARK_RANGE = { lo: 0.13, hi: 0.96 }

// Chroma multipliers per step. "tailwind" keeps backgrounds quiet and solids saturated.
const CHROMA_CURVES: Record<BrandSeeds['chromaCurve'], number[]> = {
  tailwind: [0.12, 0.24, 0.48, 0.72, 0.92, 1, 1, 0.96, 0.92, 0.88, 0.7, 0.5],
  flat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  muted: [0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45],
}

const NEUTRAL_CHROMA = 0.012
const DESTRUCTIVE_SEED = { l: 0.577, c: 0.245, h: 27.325 }
const CHART_LIGHTNESS = [0.85, 0.72, 0.6, 0.47, 0.35]
// accentHueShift: null resolves to this pinned default (documented expansion rule).
const DEFAULT_ACCENT_HUE_SHIFT = 24

// Contrast rule: text ramp steps 11/12 are L-clamped in 0.01 increments until
// WCAG contrast against the emitted background token reaches 4.5 (light darkens,
// dark lightens) — simple, deterministic, no measured-pixel magic.
const TEXT_CONTRAST_MIN = 4.5
const TEXT_STEPS = [10, 11]

const SHAPE_STEP_NAMES = ['sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'] as const
// Matches the radius scale already used by src/routes/layout.css @theme.
const SOFT_RADIUS_MULTIPLIERS = [0.6, 0.8, 1, 1.4, 1.8, 2.2, 2.6]

const ELEVATION_RECIPES: Record<Exclude<BrandSeeds['elevation'], 'flat'>, Array<{ y: number; blur: number; a: number }>> = {
  subtle: [
    { y: 1, blur: 2, a: 0.05 },
    { y: 2, blur: 4, a: 0.07 },
    { y: 4, blur: 8, a: 0.1 },
  ],
  layered: [
    { y: 1, blur: 3, a: 0.08 },
    { y: 4, blur: 12, a: 0.12 },
    { y: 12, blur: 32, a: 0.18 },
  ],
}

const MOTION_RECIPES: Record<
  BrandSeeds['motionPersonality'],
  { fast: string; slow: string; enter: string; exit: string }
> = {
  productive: {
    fast: '150ms',
    slow: '300ms',
    enter: 'cubic-bezier(0, 0, 0.2, 1)',
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
  },
  expressive: {
    fast: '250ms',
    slow: '500ms',
    enter: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
    exit: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
  },
}

const GRAIN_SVG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' seed='42' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

type RampStep = { l: number; c: number; h: number }
type Ramp = RampStep[]

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function clampChroma(c: number): number {
  return Math.min(0.4, Math.max(0, c))
}

function invertLightness(l: number): number {
  return round(DARK_RANGE.lo + ((LIGHT_MAX - l) * (DARK_RANGE.hi - DARK_RANGE.lo)) / (LIGHT_MAX - LIGHT_MIN), 4)
}

function buildRamp(seed: RampStep, multipliers: number[]): Ramp {
  return LIGHT_LADDER.map((l, i) => ({ l, c: round(clampChroma(seed.c * multipliers[i]), 4), h: seed.h }))
}

function invertRamp(ramp: Ramp): Ramp {
  return ramp.map((step) => ({ ...step, l: invertLightness(step.l) }))
}

function toOklchColor(step: RampStep): Oklch {
  return { mode: 'oklch', l: step.l, c: step.c, h: step.h }
}

function formatStep(step: RampStep): string {
  return `oklch(${round(step.l, 4)} ${round(step.c, 4)} ${round(step.h, 2)})`
}

function clampTextContrast(ramp: Ramp, background: RampStep, dark: boolean): Ramp {
  const out = [...ramp]
  for (const idx of TEXT_STEPS) {
    let step = out[idx]
    let guard = 0
    while (wcagContrast(toOklchColor(step), toOklchColor(background)) < TEXT_CONTRAST_MIN && guard < 100) {
      const l = dark ? Math.min(1, round(step.l + 0.01, 4)) : Math.max(0, round(step.l - 0.01, 4))
      step = { ...step, l }
      out[idx] = step
      guard++
    }
    out[idx] = step
  }
  return out
}

function chartColors(seeds: BrandSeeds): string[] {
  const shift = seeds.accentHueShift ?? DEFAULT_ACCENT_HUE_SHIFT
  return CHART_LIGHTNESS.map((l, i) =>
    formatStep({ l, c: round(clampChroma(seeds.seedColor.c), 4), h: round((seeds.seedColor.h + i * shift) % 360, 2) }),
  )
}

function colorVars(accent: Ramp, neutral: Ramp, destructive: Ramp, charts: string[], dark: boolean): Record<string, string> {
  // Dark mode anchors the app background at the inverted light step 1 (darkest)
  // and sits the card one step above it, preserving elevation semantics in both modes.
  const bgStep = dark ? 0 : 1
  const surfaceStep = dark ? 1 : 0
  const vars: Record<string, string> = {
    '--background': formatStep(neutral[bgStep]),
    '--foreground': formatStep(neutral[11]),
    '--card': formatStep(neutral[surfaceStep]),
    '--card-foreground': formatStep(neutral[11]),
    '--popover': formatStep(neutral[surfaceStep]),
    '--popover-foreground': formatStep(neutral[11]),
    '--primary': formatStep(accent[8]),
    '--primary-foreground': formatStep(accent[0]),
    '--secondary': formatStep(accent[3]),
    '--secondary-foreground': formatStep(neutral[11]),
    '--muted': formatStep(neutral[3]),
    '--muted-foreground': formatStep(neutral[10]),
    '--accent': formatStep(accent[3]),
    '--accent-foreground': formatStep(neutral[11]),
    '--destructive': formatStep(destructive[8]),
    '--border': formatStep(neutral[6]),
    '--input': formatStep(neutral[7]),
    '--ring': formatStep(accent[7]),
  }
  charts.forEach((color, i) => {
    vars[`--chart-${i + 1}`] = color
  })
  return vars
}

/** Utopia fluid clamp for a px size across a px viewport range (16px root). */
export function utopiaClamp(minPx: number, maxPx: number, vpMinPx: number, vpMaxPx: number): string {
  const slope = (maxPx - minPx) / (vpMaxPx - vpMinPx)
  const intercept = minPx - slope * vpMinPx
  return `clamp(${round(minPx / 16, 4)}rem, ${round(intercept / 16, 4)}rem + ${round((slope * 100) / 16, 4)}vw, ${round(maxPx / 16, 4)}rem)`
}

function trackingEm(curve: BrandSeeds['fluidScale']['trackingCurve'], step: number): string {
  switch (curve) {
    case 'negative-on-display':
      return `${round(-0.015 - 0.005 * step, 4)}em`
    case 'positive-on-display':
      return `${round(0.01 + 0.003 * step, 4)}em`
    case 'neutral':
      return '0em'
  }
}

function typeVars(seeds: BrandSeeds): Record<string, string> {
  const { baseSize, scaleRatio, viewport, scaleSteps, trackingCurve } = seeds.fluidScale
  const vars: Record<string, string> = {}
  for (let step = 0; step < scaleSteps; step++) {
    vars[`--text-step-${step}`] = utopiaClamp(
      baseSize.min * scaleRatio.min ** step,
      baseSize.max * scaleRatio.max ** step,
      viewport.min,
      viewport.max,
    )
    vars[`--text-step-${step}-lh`] = String(Math.max(1.15, round(1.5 - 0.05 * step, 2)))
    vars[`--text-step-${step}-tracking`] = trackingEm(trackingCurve, step)
  }
  vars['--font-sans'] = `"${seeds.fonts.fontPrimary}"`
  vars['--font-display'] = `"${seeds.fonts.fontSecondary}"`
  vars['--font-mono'] = `"${seeds.fonts.fontMono}"`
  return vars
}

function spaceVars(seeds: BrandSeeds): Record<string, string> {
  const { baseSize, viewport } = seeds.fluidScale
  const vars: Record<string, string> = {}
  seeds.spaceRhythm.forEach((multiplier, i) => {
    vars[`--space-${i + 1}`] = utopiaClamp(
      baseSize.min * multiplier,
      baseSize.max * multiplier,
      viewport.min,
      viewport.max,
    )
  })
  return vars
}

function shapeVars(seeds: BrandSeeds): Record<string, string> {
  // squircle emits the soft radii until CSS corner-shape ships in browsers —
  // a documented v0 limitation, not a silent fallback.
  const vars: Record<string, string> = { '--radius': seeds.radiusBase }
  SHAPE_STEP_NAMES.forEach((name, i) => {
    if (seeds.shapeCharacter === 'sharp') {
      vars[`--radius-${name}`] = '0px'
      return
    }
    if (seeds.shapeCharacter === 'pill' && i >= 3) {
      vars[`--radius-${name}`] = '999px'
      return
    }
    const m = SOFT_RADIUS_MULTIPLIERS[i]
    vars[`--radius-${name}`] = `calc(var(--radius) * ${m})`
  })
  return vars
}

function elevationVars(seeds: BrandSeeds): Record<string, string> {
  if (seeds.elevation === 'flat') return {}
  const vars: Record<string, string> = {}
  ELEVATION_RECIPES[seeds.elevation].forEach((r, i) => {
    vars[`--shadow-${i + 1}`] =
      `0 ${r.y}px ${r.blur}px oklch(0.15 0.02 ${round(seeds.neutralTintHue, 2)} / ${r.a})`
  })
  return vars
}

function motionVars(seeds: BrandSeeds): Record<string, string> {
  const recipe = MOTION_RECIPES[seeds.motionPersonality]
  return {
    '--duration-fast': recipe.fast,
    '--duration-slow': recipe.slow,
    '--ease-enter': recipe.enter,
    '--ease-exit': recipe.exit,
  }
}

function grainVars(seeds: BrandSeeds): Record<string, string> {
  if (seeds.grain <= 0) return {}
  return {
    '--grain-image': GRAIN_SVG,
    '--grain-opacity': String(seeds.grain),
  }
}

export type ExpandedStyle = {
  cssVars: Record<string, string>
  darkCssVars: Record<string, string>
  fonts: { sans: string; display: string; mono: string }
}

/** Pure, deterministic: identical seeds always produce deep-equal output. */
export function expandSeeds(seeds: BrandSeeds): ExpandedStyle {
  const parsed = brandSeedsSchema.parse(seeds)
  if (parsed.darkModeStrategy === 'm3-scheme') {
    throw new Error('darkModeStrategy "m3-scheme" is not implemented in v0 — use "invert-tone"')
  }

  const curve = CHROMA_CURVES[parsed.chromaCurve]
  const accentSeed = { ...parsed.seedColor }
  const neutralSeed = { l: 0.5, c: NEUTRAL_CHROMA, h: parsed.neutralTintHue }

  const lightAccent = buildRamp(accentSeed, curve)
  const lightNeutral = buildRamp(neutralSeed, curve)
  const lightDestructive = buildRamp(DESTRUCTIVE_SEED, curve)

  const darkAccent = invertRamp(lightAccent)
  const darkNeutral = invertRamp(lightNeutral)
  const darkDestructive = invertRamp(lightDestructive)

  const charts = chartColors(parsed)
  const cssVars: Record<string, string> = {
    ...colorVars(
      clampTextContrast(lightAccent, lightNeutral[1], false),
      clampTextContrast(lightNeutral, lightNeutral[1], false),
      lightDestructive,
      charts,
      false,
    ),
    ...typeVars(parsed),
    ...spaceVars(parsed),
    ...shapeVars(parsed),
    ...elevationVars(parsed),
    ...motionVars(parsed),
    ...grainVars(parsed),
  }
  const darkCssVars: Record<string, string> = colorVars(
    clampTextContrast(darkAccent, darkNeutral[0], true),
    clampTextContrast(darkNeutral, darkNeutral[0], true),
    darkDestructive,
    charts,
    true,
  )

  return {
    cssVars,
    darkCssVars,
    fonts: {
      sans: parsed.fonts.fontPrimary,
      display: parsed.fonts.fontSecondary,
      mono: parsed.fonts.fontMono,
    },
  }
}
