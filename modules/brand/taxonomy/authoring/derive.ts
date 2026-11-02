import type { PickerNode } from '../picker-index'
import { clampChroma, converter, parse, wcagContrast } from 'culori'
import { classifyFontFamily } from '../../style-format/fonts'

/**
 * Deterministic token derivation for the brand-picker style index (B2a).
 *
 * A hand-authored node carries a compact palette per theme ({bg, fg, primary,
 * accent[, secondary]}); this module expands it into the full shadcn colour
 * surface, formats every colour as OKLCH, and repairs text roles that miss
 * WCAG AA (4.5:1) by moving only the text colour's lightness. Corpus token
 * sets go through the same normalisation + repair. No randomness, no env.
 */

export type CompactPalette = { bg: string; fg: string; primary: string; accent: string; secondary?: string }
export type Mode = 'light' | 'dark'
type Lch = { l: number; c: number; h: number }

/** A muted surface stronger than this against the background is not "muted". */
export const MUTED_MAX_CONTRAST = 2

/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5

/** Every colour role a picker token set carries (bare names, as in REQUIRED_VISUAL_ROLES). */
export const COLOR_ROLES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
] as const
export type ColorRole = (typeof COLOR_ROLES)[number]

/** Text role → the fills it is read on. Every pair must reach MIN_CONTRAST. */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [ColorRole, ColorRole]> = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'background'],
  ['accent-foreground', 'accent'],
  ['destructive-foreground', 'destructive'],
]

const toOklch = converter('oklch')
const toOklab = converter('oklab')

function lch(css: string, what: string): Lch {
  const parsed = parse(css)
  const o = parsed ? toOklch(parsed) : undefined
  if (!o || typeof o.l !== 'number') throw new Error(`unparseable colour for ${what}: "${css}"`)
  return { l: o.l, c: typeof o.c === 'number' ? o.c : 0, h: typeof o.h === 'number' ? o.h : 0 }
}

const round = (x: number, dp: number): number => Number(x.toFixed(dp))

/** Gamut-map into sRGB (chroma reduction) and format with fixed precision. */
export function fmt(x: Lch): string {
  const l = Math.min(1, Math.max(0, x.l))
  const clamped = clampChroma({ mode: 'oklch', l, c: Math.max(0, x.c), h: x.h }, 'oklch')
  const c = typeof clamped.c === 'number' ? clamped.c : 0
  if (c < 0.0005) return `oklch(${round(l, 4)} 0 0)`
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(((x.h % 360) + 360) % 360, 2)})`
}

/** Normalise any CSS colour to the canonical OKLCH string. */
export function normalizeColor(css: string, what: string): string {
  return fmt(lch(css, what))
}

/** Linear mix in OKLab (t = 0 → a, t = 1 → b). */
function mix(a: string, b: string, t: number): string {
  const la = toOklab(parse(a)!)!
  const lb = toOklab(parse(b)!)!
  const p = (k: 'l' | 'a' | 'b') => ((la[k] as number) ?? 0) * (1 - t) + ((lb[k] as number) ?? 0) * t
  const o = toOklch({ mode: 'oklab', l: p('l'), a: p('a'), b: p('b') })!
  return fmt({ l: o.l ?? 0, c: (o.c as number) ?? 0, h: (o.h as number) ?? 0 })
}

export function contrast(a: string, b: string): number {
  return wcagContrast(a, b)
}

/**
 * Move `text` lightness (towards black or white, whichever end separates it
 * further from its fills) in 0.005 steps until it reaches MIN_CONTRAST against
 * every fill. Returns the unchanged text when it already passes.
 */
export function ensureText(text: string, fills: string[]): string {
  const worst = (t: string) => Math.min(...fills.map((f) => contrast(t, f)))
  if (worst(text) >= MIN_CONTRAST) return text
  const base = lch(text, 'text')
  const towardsBlack = worst(fmt({ ...base, l: 0 })) >= worst(fmt({ ...base, l: 1 }))
  const dir = towardsBlack ? -1 : 1
  for (let i = 1; i <= 200; i++) {
    const candidate = fmt({ ...base, l: base.l + dir * 0.005 * i })
    if (worst(candidate) >= MIN_CONTRAST) return candidate
  }
  throw new Error(`cannot reach ${MIN_CONTRAST}:1 for text ${text} on ${fills.join(', ')}`)
}

/** Text on a coloured fill: the palette's bg or fg, whichever reads better, repaired to AA. */
function onFill(fill: string, bg: string, fg: string): string {
  const best = contrast(bg, fill) >= contrast(fg, fill) ? bg : fg
  return ensureText(best, [fill])
}

const DESTRUCTIVE: Record<Mode, string> = { light: 'oklch(0.55 0.2 27)', dark: 'oklch(0.63 0.2 25)' }

/** Expand a compact palette into every colour role (already contrast-repaired). */
export function expandPalette(p: CompactPalette, mode: Mode): Record<ColorRole, string> {
  const bg = normalizeColor(p.bg, 'bg')
  const fgRaw = normalizeColor(p.fg, 'fg')
  const primary = normalizeColor(p.primary, 'primary')
  const accent = normalizeColor(p.accent, 'accent')
  const card = mode === 'light' ? mix(bg, 'oklch(1 0 0)', 0.5) : fmt({ ...lch(bg, 'bg'), l: lch(bg, 'bg').l + 0.035 })
  const secondary = p.secondary ? normalizeColor(p.secondary, 'secondary') : mix(bg, primary, mode === 'light' ? 0.12 : 0.2)
  const muted = mix(bg, fgRaw, mode === 'light' ? 0.05 : 0.08)
  const border = mix(bg, fgRaw, mode === 'light' ? 0.16 : 0.2)
  const fg = ensureText(fgRaw, [bg, card])
  const destructive = DESTRUCTIVE[mode]
  return repairContrast({
    background: bg,
    foreground: fg,
    card,
    'card-foreground': fg,
    popover: card,
    'popover-foreground': fg,
    primary,
    'primary-foreground': onFill(primary, bg, fg),
    secondary,
    'secondary-foreground': ensureText(fg, [secondary]),
    muted,
    'muted-foreground': mix(fg, bg, 0.38),
    accent,
    'accent-foreground': onFill(accent, bg, fg),
    destructive,
    'destructive-foreground': onFill(destructive, bg, fg),
    border,
    input: border,
    ring: primary,
  }).set
}

/**
 * Dark compact palette derived from a light one (used when a node authors no
 * dark palette): near-black tinted canvas, near-white text; pale surface tints
 * become dark tints, near-black ink accents become light ink, mid colours are
 * lifted to at least L 0.68 so they glow on the dark canvas.
 */
export function deriveDarkPalette(light: CompactPalette): CompactPalette {
  const bg = lch(light.bg, 'bg')
  const fg = lch(light.fg, 'fg')
  const darkBg = { l: 0.18, c: Math.min(bg.c, 0.025), h: bg.h }
  const darkFg = { l: 0.94, c: Math.min(fg.c, 0.02), h: fg.h }
  const lift = (css: string): string => {
    const x = lch(css, 'colour')
    if (x.l > 0.85) return fmt({ l: 0.3, c: x.c * 0.6, h: x.h })
    if (x.l < 0.3 && x.c < 0.06) return fmt(darkFg)
    return fmt({ ...x, l: Math.max(x.l, 0.68) })
  }
  return {
    bg: fmt(darkBg),
    fg: fmt(darkFg),
    primary: lift(light.primary),
    accent: lift(light.accent),
    ...(light.secondary ? { secondary: lift(light.secondary) } : {}),
  }
}

/** Pull the compact palette back out of a resolved corpus set (for corpus nodes lacking one theme). */
export function compactFromSet(set: Record<ColorRole, string>): CompactPalette {
  return { bg: set.background, fg: set.foreground, primary: set.primary, accent: set.accent, secondary: set.secondary }
}

/**
 * Normalise a corpus item's cssVars ("--role" keys) into the colour surface.
 * Roles a source lacks are derived from its own core palette (never invented).
 */
export function colorsFromCorpusVars(
  vars: Record<string, string>,
  mode: Mode,
  what: string,
  onReplace: (r: Repair) => void,
): Record<ColorRole, string> {
  const get = (role: string): string | undefined => vars[`--${role}`]
  const core = ['background', 'foreground', 'primary', 'accent'] as const
  for (const role of core) if (!get(role)) throw new Error(`${what}: corpus set lacks --${role}`)
  const derived = expandPalette(
    { bg: get('background')!, fg: get('foreground')!, primary: get('primary')!, accent: get('accent')!, secondary: get('secondary') },
    mode,
  )
  const out = {} as Record<ColorRole, string>
  for (const role of COLOR_ROLES) {
    const v = get(role)
    out[role] = v ? normalizeColor(v, `${what} --${role}`) : derived[role]
  }
  // muted is a subtle surface next to the background; a source that maps it to
  // a strong fill (some daisyUI themes) gets the derived subtle surface instead.
  if (contrast(out.muted, out.background) > MUTED_MAX_CONTRAST) {
    onReplace({ role: 'muted', from: out.muted, to: derived.muted })
    out.muted = derived.muted
  }
  return out
}

export type Repair = { role: ColorRole; from: string; to: string }

/** Repair every text role that misses AA against any of its fills (lightness only). */
export function repairContrast(set: Record<ColorRole, string>): { set: Record<ColorRole, string>; repairs: Repair[] } {
  const out = { ...set }
  const repairs: Repair[] = []
  const textRoles = [...new Set(CONTRAST_PAIRS.map(([t]) => t))]
  for (const role of textRoles) {
    const fills = CONTRAST_PAIRS.filter(([t]) => t === role).map(([, f]) => out[f])
    let fixed: string
    try {
      fixed = ensureText(out[role], fills)
    } catch (err) {
      throw new Error(`--${role}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
    if (fixed !== out[role]) {
      repairs.push({ role, from: out[role], to: fixed })
      out[role] = fixed
    }
  }
  return { set: out, repairs }
}

export type ContrastFailure = { text: ColorRole; fill: ColorRole; ratio: number }

/** Deterministic AA check over CONTRAST_PAIRS (ratios rounded to 2dp). */
export function contrastFailures(set: Record<string, string>): ContrastFailure[] {
  const failures: ContrastFailure[] = []
  for (const [text, fill] of CONTRAST_PAIRS) {
    const ratio = round(contrast(set[text]!, set[fill]!), 2)
    if (ratio < MIN_CONTRAST) failures.push({ text, fill, ratio })
  }
  return failures
}

export const RADIUS_VALUE: Record<PickerNode['shape']['radius'], string> = {
  none: '0rem',
  xs: '0.125rem',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  pill: '9999px',
}

/** Base spacing step (rem) per density — feeds the style vector's spacing dimension. */
export const DENSITY_STEP: Record<PickerNode['shape']['density'], number> = {
  compact: 0.1875,
  regular: 0.25,
  airy: 0.375,
}

const GENERIC = { sans: 'sans-serif', display: 'sans-serif', serif: 'serif', mono: 'monospace' } as const

/** `"Family", generic` — the family is classified (throws on unknown fonts). */
export function fontStack(family: string): string {
  return `"${family}", ${GENERIC[classifyFontFamily(family)]}`
}
