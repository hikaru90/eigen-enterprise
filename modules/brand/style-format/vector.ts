import type { BrandCorpusItem } from './corpus'
import { converter, parse } from 'culori'
import { classifyFontFamily, FONT_CLASS_DISTANCE, type FontClass } from './fonts'

/**
 * Deterministic style similarity (phase-2d V6). Vectors are computed from
 * corpus items' resolved cssVars (source of truth — seeds only fill dimensions
 * tier-1 sources cannot express), and distances are a fixed weighted sum:
 *
 *   distance = 0.45 * colorComp        (mean OKLab euclidean over 10 roles,
 *                                       normalized by COLOR_COMP_NORM)
 *            + 0.25 * shapeComp        (radius + spacing, both normalized 0..1)
 *            + 0.20 * typographyComp   (font-class matrix ×3 slots + weight set)
 *            + 0.10 * effectsComp      (dark-mode delta, grain, elevation)
 *
 * Every component and sub-weight is pinned below. No randomness, no env, no
 * LLM — identical items always produce identical vectors and distances.
 */

export const STYLE_DISTANCE_WEIGHTS = {
  color: 0.45,
  shape: 0.25,
  typography: 0.2,
  effects: 0.1,
} as const

/** Sub-weights inside the typography component. */
const TYPOGRAPHY_PARTS = { slots: 0.85, weightSet: 0.15 } as const
/** Sub-weights inside the shape component. */
const SHAPE_PARTS = { radius: 0.5, spacing: 0.5 } as const
/** Sub-weights inside the effects component. */
const EFFECTS_PARTS = { darkDelta: 0.4, grain: 0.3, elevation: 0.3 } as const

/** The 10 core shadcn color roles entering the color component. */
export const VECTOR_ROLES = [
  'background',
  'foreground',
  'primary',
  'secondary',
  'accent',
  'muted',
  'border',
  'ring',
  'card',
  'destructive',
] as const
export type VectorRole = (typeof VECTOR_ROLES)[number]

/** cssVar name for a role, e.g. background -> --background. */
const roleVar = (role: VectorRole): string => `--${role}`

export type OklchTriple = { l: number; c: number; h: number }

export type StyleVector = {
  /** Raw OKLCH components per core role (hue pinned to 0 when achromatic). */
  colors: Record<VectorRole, OklchTriple>
  /** --radius in rem, normalized by RADIUS_NORM, clamped to 0..1. */
  radius: number
  /** Base spacing step in rem, normalized by SPACING_NORM, clamped to 0..1. */
  spacing: number
  /** Categorical class per font slot (exact table lookup — see fonts.ts). */
  fontClasses: { sans: FontClass; display: FontClass; mono: FontClass }
  /** 1 when the cssVars carry an explicit font-weight set, else 0. */
  weightSet: 0 | 1
  /** Mean background delta light vs dark, normalized to 0..1 (0 = no dark set). */
  darkDelta: number
  /** Grain amount 0..1 (from seeds — every corpus item carries seeds). */
  grain: number
  /** Elevation mapped flat=0, subtle=0.5, layered=1. */
  elevation: number
}

// ---------------------------------------------------------------------------
// Normalization constants (pinned, documented).
// ---------------------------------------------------------------------------

/** --radius of 2rem and beyond saturates the radius dimension (pill ≈ 1). */
const RADIUS_NORM = 2
/**
 * Base spacing step of 1.5rem saturates the density dimension. The base step
 * is --space-1 (or seeds spaceRhythm[0] × base size for sources without a
 * space scale), e.g. the 0.25rem default lands at 1/6.
 */
const SPACING_NORM = 1.5
/** Light-vs-dark background OKLab distance of ~0.9 saturates darkDelta. */
const DARK_DELTA_NORM = 0.9
/**
 * Color component normalization reference: a mean OKLab ΔE of 0.1 across the
 * 10 core roles counts as a maximally different palette identity and
 * saturates the component (light↔dark pairs measure ~0.3-0.45 and clamp;
 * same-family palettes measure ~0.005-0.03). Without this reference the raw
 * mean ΔE of light-theme pairs is so small that the spec's 0.35 cluster
 * threshold could never separate natural style families.
 */
const COLOR_COMP_NORM = 0.1

const ELEVATION_POSITION: Record<BrandCorpusItem['seeds']['elevation'], number> = {
  flat: 0,
  subtle: 0.5,
  layered: 1,
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6

function parseOklch(cssValue: string, role: string): OklchTriple {
  const parsed = parse(cssValue)
  if (!parsed) throw new Error(`unparseable color for --${role}: "${cssValue}"`)
  const oklch = converter('oklch')(parsed)
  if (!oklch || oklch.l === undefined) {
    throw new Error(`color for --${role} does not resolve to OKLCH: "${cssValue}"`)
  }
  return { l: oklch.l, c: oklch.c ?? 0, h: oklch.h ?? 0 } // h ?? 0: achromatic hue pinned to 0
}

/** Euclidean distance in OKLab (perceptually even) between two OKLCH triples. */
export function oklabDistance(a: OklchTriple, b: OklchTriple): number {
  const toOkLab = (x: OklchTriple) => converter('oklab')({ mode: 'oklch', ...x })
  const la = toOkLab(a)
  const lb = toOkLab(b)
  if (!la || !lb) throw new Error('oklab conversion failed')
  const dL = la.l - lb.l
  const da = (la.a ?? 0) - (lb.a ?? 0)
  const db = (la.b ?? 0) - (lb.b ?? 0)
  return Math.sqrt(dL * dL + da * da + db * db)
}

/** Parse a CSS length (px|rem) into rem. Throws on anything else — loud. */
function cssLengthToRem(value: string, what: string): number {
  const match = /^(\d*\.?\d+)(px|rem)$/.exec(value.trim())
  if (!match) throw new Error(`cannot parse ${what} as CSS length: "${value}"`)
  return match[2] === 'px' ? Number(match[1]) / 16 : Number(match[1])
}

/**
 * Extract the min-rem step from a Utopia clamp like
 * `clamp(0.25rem, 0.2rem + 0.025vw, 0.3rem)`. Throws loud on other shapes.
 */
function clampMinRem(value: string, what: string): number {
  const match = /^clamp\((\d*\.?\d+)rem,/.exec(value.trim())
  if (!match) throw new Error(`cannot parse ${what} clamp min: "${value}"`)
  return Number(match[1])
}

function firstNamedFamily(fontValue: string): string {
  const first = fontValue.split(',')[0]?.trim() ?? ''
  const family = first.replace(/^"(.*)"$/, '$1').trim()
  if (!family) throw new Error(`cannot parse font family from "${fontValue}"`)
  return family
}

function fontClass(cssVars: Record<string, string>, varName: string): FontClass {
  const value = cssVars[varName]
  if (!value) throw new Error(`missing cssVar ${varName} for style vector`)
  return classifyFontFamily(firstNamedFamily(value))
}

/** Build the style vector for one corpus item. Fails loud on missing tokens. */
export function styleVector(item: BrandCorpusItem): StyleVector {
  const missing = VECTOR_ROLES.filter((role) => !(roleVar(role) in item.cssVars))
  if (missing.length > 0) {
    throw new Error(`corpus item "${item.name}" is missing cssVar roles: ${missing.map(roleVar).join(', ')}`)
  }

  const colors = Object.fromEntries(
    VECTOR_ROLES.map((role) => [role, parseOklch(item.cssVars[roleVar(role)], role)]),
  ) as Record<VectorRole, OklchTriple>

  const radius = clamp01(cssLengthToRem(item.cssVars['--radius'], '--radius') / RADIUS_NORM)

  let spacingRem: number
  if (typeof item.cssVars['--space-1'] === 'string') {
    spacingRem = clampMinRem(item.cssVars['--space-1'], '--space-1')
  } else {
    // Tier-1 sources carry no space scale: derive the base step from seeds
    // (documented precedence — seeds only fill dimensions cssVars lack).
    spacingRem = (item.seeds.fluidScale.baseSize.min / 16) * item.seeds.spaceRhythm[0]
  }
  const spacing = clamp01(spacingRem / SPACING_NORM)

  const darkBg = item.darkCssVars['--background']
  const darkDelta = darkBg
    ? clamp01(oklabDistance(parseOklch(item.cssVars['--background'], 'background'), parseOklch(darkBg, 'dark background')) / DARK_DELTA_NORM)
    : 0

  return {
    colors,
    radius,
    spacing,
    fontClasses: {
      sans: fontClass(item.cssVars, '--font-sans'),
      display: fontClass(item.cssVars, '--font-display'),
      mono: fontClass(item.cssVars, '--font-mono'),
    },
    weightSet: Object.keys(item.cssVars).some((k) => k.startsWith('--font-weight')) ? 1 : 0,
    darkDelta,
    grain: item.seeds.grain,
    elevation: ELEVATION_POSITION[item.seeds.elevation],
  }
}

/** Weighted symmetric style distance in 0..1 (see module doc for the formula). */
export function styleDistance(a: StyleVector, b: StyleVector): number {
  const colorComp = clamp01(
    VECTOR_ROLES.reduce((sum, role) => sum + oklabDistance(a.colors[role], b.colors[role]), 0) /
      VECTOR_ROLES.length /
      COLOR_COMP_NORM,
  )

  const shapeComp =
    SHAPE_PARTS.radius * Math.abs(a.radius - b.radius) + SHAPE_PARTS.spacing * Math.abs(a.spacing - b.spacing)

  const slotDist = (x: FontClass, y: FontClass) => FONT_CLASS_DISTANCE[x][y]
  const slots =
    (slotDist(a.fontClasses.sans, b.fontClasses.sans) +
      slotDist(a.fontClasses.display, b.fontClasses.display) +
      slotDist(a.fontClasses.mono, b.fontClasses.mono)) /
    3
  const typographyComp = TYPOGRAPHY_PARTS.slots * slots + TYPOGRAPHY_PARTS.weightSet * Math.abs(a.weightSet - b.weightSet)

  const effectsComp =
    EFFECTS_PARTS.darkDelta * Math.abs(a.darkDelta - b.darkDelta) +
    EFFECTS_PARTS.grain * Math.abs(a.grain - b.grain) +
    EFFECTS_PARTS.elevation * Math.abs(a.elevation - b.elevation)

  return clamp01(
    STYLE_DISTANCE_WEIGHTS.color * colorComp +
      STYLE_DISTANCE_WEIGHTS.shape * shapeComp +
      STYLE_DISTANCE_WEIGHTS.typography * typographyComp +
      STYLE_DISTANCE_WEIGHTS.effects * effectsComp,
  )
}

// ---------------------------------------------------------------------------
// Fixed numeric emit layout (for stored centroids in corpus/index.json).
// 30 color (l, c/0.4, h/360 × 10 roles) + radius + spacing
// + 12 font one-hot (3 slots × 4 classes) + 4 scalars (weightSet, darkDelta,
// grain, elevation) = 48.
// ---------------------------------------------------------------------------

export const NUMERIC_DIMS = 48
const FONT_CLASS_ORDER: FontClass[] = ['sans', 'serif', 'mono', 'display']

/** Flatten a vector into the fixed 47-dim normalized layout (rounded to 6dp). */
export function toNumericVector(v: StyleVector): number[] {
  const out: number[] = []
  for (const role of VECTOR_ROLES) {
    const { l, c, h } = v.colors[role]
    out.push(round6(l), round6(clamp01(c / 0.4)), round6(h / 360))
  }
  out.push(round6(v.radius), round6(v.spacing))
  for (const slot of [v.fontClasses.sans, v.fontClasses.display, v.fontClasses.mono]) {
    for (const cls of FONT_CLASS_ORDER) out.push(slot === cls ? 1 : 0)
  }
  out.push(v.weightSet, round6(v.darkDelta), round6(v.grain), round6(v.elevation))
  return out
}
