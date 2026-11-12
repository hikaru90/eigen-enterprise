import { clampChroma, converter, parse } from 'culori'

/**
 * WCAG 2.1 contrast for the theme tokens (Contribute b73604ff, round 3 W6):
 * the ONE list of token pairs the UI paints together, the ratio math (with
 * alpha compositing, the way the browser paints `text-x/60` or `bg-x/10`),
 * and the deterministic correction an active brand set goes through before
 * it themes the app.
 *
 * Used by the app's own token spec (src/routes/layout.contrast.spec.ts) and by
 * the brand emitter (emitter.ts / component-set.ts), so the app's tokens and a
 * company's brand tokens are held to the same minimums.
 */

/** SC 1.4.3: body text. */
export const AA_TEXT = 4.5
/** SC 1.4.11: UI component boundaries and focus indicators (and SC 1.4.3 large text). */
export const AA_UI = 3

/** Opaque-or-not sRGB, channels 0..1. */
export type Rgba = { r: number; g: number; b: number; alpha: number }

/** One painted layer: a token, optionally with a Tailwind opacity modifier (`bg-muted/50` → 0.5). */
export type ThemeLayer = { token: `--${string}`; alpha?: number }

export type ContrastPair = {
  id: string
  /** The text / indicator painted on top. This is the token a correction moves. */
  fg: ThemeLayer
  /** The surface under it, bottom layer first; the bottom layer must be opaque. */
  on: readonly ThemeLayer[]
  min: number
  /** Where the UI paints this pair (keeps the list honest). */
  use: string
}

const toRgb = converter('rgb')
const toOklch = converter('oklch')

function clip(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/** Parse a CSS color token value; unparseable values fail loud (no guessing). */
export function parseColor(value: string, what: string): Rgba {
  const parsed = parse(value.trim())
  const rgb = parsed ? toRgb(parsed) : undefined
  if (!rgb || rgb.r === undefined || rgb.g === undefined || rgb.b === undefined) {
    throw new Error(`contrast: unparseable color for ${what}: "${value}"`)
  }
  return { r: clip(rgb.r), g: clip(rgb.g), b: clip(rgb.b), alpha: clip(rgb.alpha ?? 1) }
}

/** Source-over compositing of `top` onto an opaque `bottom` (gamma-encoded sRGB, as browsers paint). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  if (bottom.alpha < 1) throw new Error('contrast: composite needs an opaque bottom layer')
  const a = top.alpha
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    alpha: 1,
  }
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.1 relative luminance of an opaque color. */
export function relativeLuminance(color: Rgba): number {
  if (color.alpha < 1) throw new Error('contrast: luminance needs an opaque color')
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

/** WCAG 2.1 contrast ratio of two opaque colors (1..21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function layerColor(tokens: Record<string, string>, layer: ThemeLayer): Rgba {
  const value = tokens[layer.token]
  if (value === undefined) throw new Error(`contrast: token ${layer.token} is not declared`)
  const color = parseColor(value, layer.token)
  return { ...color, alpha: color.alpha * (layer.alpha ?? 1) }
}

/** The opaque surface a pair's foreground lands on. */
export function resolveSurface(
  tokens: Record<string, string>,
  layers: readonly ThemeLayer[],
): Rgba {
  const [bottom, ...rest] = layers
  if (!bottom) throw new Error('contrast: a surface needs at least one layer')
  const base = layerColor(tokens, bottom)
  if (base.alpha < 1) {
    throw new Error(`contrast: bottom layer ${bottom.token} must be opaque (alpha ${base.alpha})`)
  }
  return rest.reduce((under, layer) => composite(layerColor(tokens, layer), under), base)
}

/** The painted contrast of one pair under a token record. */
export function pairContrast(tokens: Record<string, string>, pair: ContrastPair): number {
  const surface = resolveSurface(tokens, pair.on)
  return contrastRatio(composite(layerColor(tokens, pair.fg), surface), surface)
}

function pairTokens(pair: ContrastPair): string[] {
  return [pair.fg.token, ...pair.on.map((layer) => layer.token)]
}

const fg = (token: `--${string}`, alpha?: number): ThemeLayer =>
  alpha === undefined ? { token } : { token, alpha }

function pairsOn(
  fgLayer: ThemeLayer,
  surfaces: readonly (readonly ThemeLayer[])[],
  min: number,
  use: string,
): ContrastPair[] {
  return surfaces.map((on) => ({
    id: `${fgLayer.token.slice(2)}${fgLayer.alpha === undefined ? '' : `/${fgLayer.alpha * 100}`} on ${on
      .map((l) => `${l.token.slice(2)}${l.alpha === undefined ? '' : `/${l.alpha * 100}`}`)
      .join(' + ')}`,
    fg: fgLayer,
    on,
    min,
    use,
  }))
}

const BG: ThemeLayer[] = [{ token: '--background' }]
const CARD: ThemeLayer[] = [{ token: '--card' }]
const POPOVER: ThemeLayer[] = [{ token: '--popover' }]
const MUTED: ThemeLayer[] = [{ token: '--muted' }]
const PLAIN_SURFACES = [BG, CARD, POPOVER, MUTED]

/**
 * Every token pair the shared UI paints together (src/lib/components/ui/** and
 * the shells). Text pairs at 4.5:1 — all of them carry body-size text, so the
 * large-text 3:1 never applies to a token pair. UI pairs at 3:1: the input
 * boundary (text fields, select, checkbox, radio, switch track) and the focus
 * ring. `--border` is not here on purpose: it draws decorative separators
 * (cards, dividers, table rules), which SC 1.4.11 exempts; every control whose
 * boundary identifies it uses `--input`.
 */
export const THEME_CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...pairsOn(fg('--foreground'), PLAIN_SURFACES, AA_TEXT, 'body text on every surface'),
  ...pairsOn(fg('--card-foreground'), [CARD], AA_TEXT, 'card text'),
  ...pairsOn(fg('--popover-foreground'), [POPOVER], AA_TEXT, 'popover / select / dialog text'),
  ...pairsOn(
    fg('--primary-foreground'),
    [[{ token: '--primary' }]],
    AA_TEXT,
    'default button, badge',
  ),
  ...pairsOn(
    fg('--secondary-foreground'),
    [[{ token: '--secondary' }]],
    AA_TEXT,
    'secondary button, badge',
  ),
  ...pairsOn(
    fg('--accent-foreground'),
    [[{ token: '--accent' }]],
    AA_TEXT,
    'highlighted menu / select item',
  ),
  ...pairsOn(
    fg('--muted-foreground'),
    PLAIN_SURFACES,
    AA_TEXT,
    'secondary text: descriptions, captions, placeholders, inactive tabs',
  ),
  ...pairsOn(
    fg('--destructive'),
    [
      ...PLAIN_SURFACES,
      [{ token: '--background' }, { token: '--destructive', alpha: 0.1 }],
      [{ token: '--card' }, { token: '--destructive', alpha: 0.1 }],
      [{ token: '--background' }, { token: '--destructive', alpha: 0.2 }],
      [{ token: '--card' }, { token: '--destructive', alpha: 0.2 }],
    ],
    AA_TEXT,
    'error text; destructive button / badge (tinted fill)',
  ),
  ...pairsOn(fg('--input'), [BG, CARD, POPOVER], AA_UI, 'form control boundary, switch track'),
  ...pairsOn(fg('--ring'), PLAIN_SURFACES, AA_UI, 'focus ring'),
]

export type ContrastResult = { pair: ContrastPair; ratio: number; pass: boolean }

/** Measure every pair; a pair whose token is missing from `tokens` fails loud. */
export function auditContrast(
  tokens: Record<string, string>,
  pairs: readonly ContrastPair[] = THEME_CONTRAST_PAIRS,
): ContrastResult[] {
  return pairs.map((pair) => {
    const ratio = pairContrast(tokens, pair)
    return { pair, ratio, pass: ratio >= pair.min }
  })
}

// ---------------------------------------------------------------------------
// Correction (brand sets)
// ---------------------------------------------------------------------------

type Oklcha = { l: number; c: number; h: number; alpha: number }

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function toOklcha(value: string, what: string): Oklcha {
  const parsed = parse(value.trim())
  const o = parsed ? toOklch(parsed) : undefined
  if (!o || o.l === undefined)
    throw new Error(`contrast: unparseable color for ${what}: "${value}"`)
  return { l: o.l, c: o.c ?? 0, h: o.h ?? 0, alpha: o.alpha ?? 1 }
}

/** In-gamut (sRGB) oklch() text: chroma is reduced, never lightness, so the measured ratio is what paints. */
function formatOklcha(color: Oklcha): string {
  const fitted = clampChroma({ mode: 'oklch', l: color.l, c: color.c, h: color.h }, 'oklch')
  const l = round(fitted.l ?? color.l, 4)
  const c = round(fitted.c ?? 0, 4)
  const h = round(fitted.h ?? color.h, 2)
  const alpha = round(color.alpha, 3)
  return alpha < 1 ? `oklch(${l} ${c} ${h} / ${alpha})` : `oklch(${l} ${c} ${h})`
}

const L_STEP = 0.005
const ALPHA_STEP = 0.01
const MAX_STEPS = 400

/**
 * One deterministic step away from the surface: a translucent token on the
 * right side of the surface gains opacity first (keeps its hue and look),
 * otherwise OKLCH lightness moves. Null when nothing is left to move.
 */
function step(color: Oklcha, darken: boolean, surfaceLuminance: number): Oklcha | null {
  if (color.alpha < 1) {
    const opaque = parseColor(formatOklcha({ ...color, alpha: 1 }), 'step')
    const rightSide = darken
      ? relativeLuminance(opaque) < surfaceLuminance
      : relativeLuminance(opaque) > surfaceLuminance
    if (rightSide) return { ...color, alpha: Math.min(1, round(color.alpha + ALPHA_STEP, 3)) }
  }
  const l = darken
    ? Math.max(0, round(color.l - L_STEP, 4))
    : Math.min(1, round(color.l + L_STEP, 4))
  if (l === color.l) {
    return color.alpha < 1
      ? { ...color, alpha: Math.min(1, round(color.alpha + ALPHA_STEP, 3)) }
      : null
  }
  return { ...color, l }
}

/** Toward whichever end (black or white) has more contrast headroom on a surface. */
function darkenOn(surfaceLuminance: number): boolean {
  return (surfaceLuminance + 0.05) / 0.05 >= 1.05 / (surfaceLuminance + 0.05)
}

/** Step `token` in one direction until every pair passes; fails loud when it runs out of room. */
function moveUntilPass(
  out: Record<string, string>,
  token: string,
  pairs: readonly ContrastPair[],
  darken: boolean | null,
): void {
  const failing = () => pairs.find((pair) => pairContrast(out, pair) < pair.min)
  let first = failing()
  if (!first) return
  const surfaceLuminance = relativeLuminance(resolveSurface(out, first.on))
  const down = darken ?? darkenOn(surfaceLuminance)
  let color = toOklcha(out[token], token)
  for (let i = 0; i < MAX_STEPS && first; i++) {
    const next = step(color, down, surfaceLuminance)
    if (!next) break
    color = next
    out[token] = formatOklcha(color)
    first = failing()
  }
  if (first) {
    throw new Error(
      `contrast: ${first.id} cannot reach ${first.min}:1 (best ${pairContrast(out, first).toFixed(2)}:1) — the theme leaves no room for ${token}`,
    )
  }
}

const BACKGROUND = '--background'
/** Surfaces that carry the theme's own text colours next to the background. */
const TEXT_SURFACES = ['--card', '--popover', '--muted'] as const
const TEXT_TOKENS = ['--foreground', '--muted-foreground'] as const

/**
 * The tokens corrected so every pair meets its minimum, staying as close to
 * the theme as the minimums allow; a token that already passes is returned
 * byte-identical. Three deterministic passes:
 *  1. each foreground / indicator is anchored on `--background` (moved in
 *     OKLCH lightness, or opacity for a translucent token);
 *  2. a card / popover / muted surface that sits on the wrong side of the
 *     theme's text colours (a dark `--muted` in a light theme — common in
 *     daisyUI mappings) or so close to them that no text colour can reach AA
 *     on it moves toward the background until the theme's own text passes on
 *     it — otherwise surfaces never move: they are the brand;
 *  3. every foreground / indicator moves until all its pairs pass.
 * Pairs the record does not fully declare are not this record's to correct
 * (the app's own tokens cover the rest; every brand creation path emits the
 * full role set). An unreachable minimum fails loud.
 */
export function enforceContrast(
  tokens: Record<string, string>,
  pairs: readonly ContrastPair[] = THEME_CONTRAST_PAIRS,
): Record<string, string> {
  const out = { ...tokens }
  const declared = pairs.filter((pair) => pairTokens(pair).every((token) => token in out))
  const movable = [...new Set(declared.map((pair) => pair.fg.token))]
  const own = (token: string) => declared.filter((pair) => pair.fg.token === token)

  // 1. Anchor on the background.
  for (const token of movable) {
    const anchor = own(token).filter(
      (pair) =>
        pair.on.length === 1 && pair.on[0].token === BACKGROUND && pair.on[0].alpha === undefined,
    )
    moveUntilPass(out, token, anchor, null)
  }

  // 2. Bring incoherent text surfaces to the background's side.
  if (BACKGROUND in out) {
    const bg = parseColor(out[BACKGROUND], BACKGROUND)
    const bgLum = relativeLuminance(bg)
    for (const surface of TEXT_SURFACES) {
      if (!(surface in out)) continue
      const refs = TEXT_TOKENS.filter((token) => token in out)
      const checks: ContrastPair[] = refs.map((token) => ({
        id: `${token.slice(2)} on ${surface.slice(2)}`,
        fg: { token },
        on: [{ token: surface }],
        min: AA_TEXT,
        use: 'surface coherence',
      }))
      const sLum = relativeLuminance(resolveSurface(out, [{ token: surface }]))
      const incoherent = refs.find((token) => {
        const refLum = relativeLuminance(composite(parseColor(out[token], token), bg))
        const darkText = bgLum > refLum
        const wrongSide = darkText ? sLum <= refLum : sLum >= refLum
        const best = darkText ? (sLum + 0.05) / 0.05 : 1.05 / (sLum + 0.05)
        return wrongSide || best < AA_TEXT
      })
      if (incoherent === undefined) continue
      const refLum = relativeLuminance(composite(parseColor(out[incoherent], incoherent), bg))
      moveUntilPass(out, surface, checks, bgLum < refLum)
    }
  }

  // 3. Every pair.
  for (const token of movable) moveUntilPass(out, token, own(token), null)
  return out
}
