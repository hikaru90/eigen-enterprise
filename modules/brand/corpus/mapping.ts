/**
 * Pure tier-1 mapping logic (phase-2d M3). Typed TS module — the plain-JS
 * mapping.mjs predecessor got pulled into the svelte-check program when
 * modules/** was enrolled (checkJs flagged every untyped line), so it is now
 * a properly typed mapping.ts; behavior is byte-stable and mapping.spec.ts
 * asserts that unchanged. BOTH the vitest-driven corpus build and the
 * owner-run ingest script import it: plain node >= 22.18 strips TS types
 * natively, so ingest-tier1.mjs consumes this file directly. File I/O and
 * network stay in ingest-tier1.mjs; everything in this module is
 * deterministic and unit-tested in mapping.spec.ts.
 */
import type { BrandCorpusItem } from '../style-format/corpus'
import type { BrandSeeds } from '../style-format/seeds'
import { createHash } from 'node:crypto'
import { converter, parse } from 'culori'

/** OKLCH component triple (BrandSeeds.seedColor shape). */
type OklchTriple = BrandSeeds['seedColor']

/** OFL font slots carried by every corpus item. */
type Tier1Fonts = BrandSeeds['fonts']

/** Named CSS font stacks a tier-1 source may provide. */
type FontStacks = { sans: string; serif: string; mono: string }

/** Tweakcn registry-item preset (shadcn registry JSON, subset we consume). */
type TweakcnPreset = {
  name: string
  title?: string
  cssVars?: {
    theme?: Record<string, string | undefined>
    light?: Record<string, string>
    dark?: Record<string, string>
  }
}

/** Pinned uuid-v5 namespace for corpus ids — never change it (ids are stable in git). */
const CORPUS_NAMESPACE_HEX = 'e8c1a7d03b5f4e629a4d2f8b6c1d5e7a'

/**
 * Deterministic uuid (v5 shape: sha1 of namespace bytes + name, version/variant
 * bits set). Corpus item ids derive from the source+name slug so the same
 * theme always maps to the same id across rebuilds. (The corpus schema demands
 * uuid ids; the readable slug lives on in the filename.)
 */
export function deterministicUuid(name: string): string {
  const hash = createHash('sha1')
  hash.update(Buffer.from(CORPUS_NAMESPACE_HEX, 'hex'))
  hash.update(name, 'utf8')
  const bytes = Buffer.from(hash.digest('hex'), 'hex')
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Deterministic slug for a corpus item: `daisyui-cupcake`, `tweakcn-vercel`, `archetype-brutalist`. */
export function corpusSlug(source: string, name: string): string {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error(`cannot slugify corpus item name: "${name}" (source: ${source})`)
  return `${source}-${slug}`
}

/** Pinned creation timestamp for build-time-generated items (determinism: no wall clock in content). */
export const BUILD_EPOCH = '2026-09-09T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Color/length helpers (thin deterministic wrappers over culori).
// ---------------------------------------------------------------------------

function parseOklch(cssValue: string, what: string): OklchTriple {
  const parsed = parse(cssValue)
  if (!parsed) throw new Error(`unparseable color for ${what}: "${cssValue}"`)
  const oklch = converter('oklch')(parsed)
  if (!oklch) throw new Error(`color does not resolve to OKLCH for ${what}: "${cssValue}"`)
  const l = oklch.l
  if (l === undefined) throw new Error(`color resolves to OKLCH without lightness for ${what}: "${cssValue}"`)
  return {
    l: Math.round(l * 10000) / 10000,
    c: Math.round((oklch.c ?? 0) * 10000) / 10000,
    h: oklch.h === undefined ? 0 : Math.round(oklch.h * 100) / 100, // achromatic hue pinned to 0
  }
}

function formatOklch(triple: OklchTriple): string {
  return `oklch(${triple.l} ${triple.c} ${triple.h})`
}

function cssLengthToRem(value: string, what: string): number {
  const match = /^(\d*\.?\d+)(px|rem|pt)?$/.exec(String(value).trim())
  if (!match) throw new Error(`cannot parse ${what} as CSS length: "${value}"`)
  const n = Number(match[1])
  if (match[2] === 'px') return Math.round((n / 16) * 10000) / 10000
  if (match[2] === 'pt') return Math.round((n * (4 / 3) / 16) * 10000) / 10000
  return n
}

function clampLightness(triple: OklchTriple, lo: number, hi: number): OklchTriple {
  return { ...triple, l: Math.min(hi, Math.max(lo, triple.l)) }
}

// ---------------------------------------------------------------------------
// daisyUI theme parsing (bundled per-theme CSS in the daisyui npm package).
// ---------------------------------------------------------------------------

/**
 * Parse one daisyUI theme CSS file (theme/<name>.css). Returns
 * { scheme, vars } where vars holds every `--key: value` declaration.
 * Throws loud when the file does not match the expected daisyUI v5 layout.
 */
export function parseDaisyUiThemeCss(cssText: string, themeName: string): { scheme: string; vars: Record<string, string> } {
  const blockStart = cssText.indexOf('{')
  const blockEnd = cssText.lastIndexOf('}')
  if (blockStart === -1 || blockEnd === -1 || blockEnd <= blockStart) {
    throw new Error(`daisyUI theme "${themeName}": no CSS block found`)
  }
  const schemeMatch = /color-scheme:\s*(light|dark)\s*;/.exec(cssText.slice(0, blockEnd))
  if (!schemeMatch) throw new Error(`daisyUI theme "${themeName}": missing color-scheme declaration`)
  const vars: Record<string, string> = {}
  const body = cssText.slice(blockStart + 1, blockEnd)
  for (const line of body.split(';')) {
    const decl = /^(\s*--[\w-]+)\s*:\s*(.+)$/.exec(line)
    if (decl) vars[decl[1].trim()] = decl[2].trim()
  }
  if (Object.keys(vars).length === 0) {
    throw new Error(`daisyUI theme "${themeName}": no custom properties found in theme block`)
  }
  return { scheme: schemeMatch[1], vars }
}

/**
 * daisyUI var → shadcn role mapping (the table implemented in
 * mapDaisyUiVarsToShadcn). `←derived` marks deterministic derivations.
 *
 * | daisyUI var            | shadcn role(s)                                                     |
 * |------------------------|--------------------------------------------------------------------|
 * | --color-base-100       | background, popover                                                |
 * | --color-base-200       | card                                                               |
 * | --color-base-300       | border, input                                                      |
 * | --color-base-content   | foreground, card-foreground, popover-foreground,                   |
 * |                        | secondary-foreground, accent-foreground                            |
 * | --color-primary        | primary, ring ←derived (ring = primary, shadcn convention)         |
 * | --color-primary-content| primary-foreground                                                 |
 * | --color-secondary      | secondary                                                          |
 * | --color-secondary-content| secondary-foreground ←overridden by base-content (see below)     |
 * | --color-accent         | accent                                                             |
 * | --color-neutral        | muted                                                              |
 * | --color-neutral-content| muted-foreground ←derived: base-content L clamped into 0.35..0.65  |
 * | --color-error          | destructive                                                        |
 * | --color-error-content  | destructive-foreground                                             |
 * | --radius-field         | radius (buttons/inputs = shadcn --radius semantics)                |
 *
 * muted-foreground derivation: daisyUI's content colors are contrast-tuned
 * against their own surface, not against the background; shadcn's
 * muted-foreground is secondary text on the background, so we take
 * base-content (the background-tuned content color) with lightness clamped
 * into the 0.35..0.65 mid band — readable, muted, deterministic.
 */
export function mapDaisyUiVarsToShadcn(vars: Record<string, string>, themeName: string): Record<string, string> {
  const required = [
    '--color-base-100',
    '--color-base-200',
    '--color-base-300',
    '--color-base-content',
    '--color-primary',
    '--color-primary-content',
    '--color-secondary',
    '--color-accent',
    '--color-neutral',
    '--color-error',
    '--color-error-content',
    '--radius-field',
  ]
  const missing = required.filter((k) => !(k in vars))
  if (missing.length > 0) {
    throw new Error(`daisyUI theme "${themeName}": missing vars ${missing.join(', ')}`)
  }

  const baseContent = parseOklch(vars['--color-base-content'], `${themeName} base-content`)
  const mutedForeground = clampLightness(baseContent, 0.35, 0.65)

  return {
    '--background': vars['--color-base-100'],
    '--popover': vars['--color-base-100'],
    '--card': vars['--color-base-200'],
    '--card-foreground': vars['--color-base-content'],
    '--popover-foreground': vars['--color-base-content'],
    '--foreground': vars['--color-base-content'],
    '--primary': vars['--color-primary'],
    '--primary-foreground': vars['--color-primary-content'],
    '--secondary': vars['--color-secondary'],
    '--secondary-foreground': vars['--color-base-content'],
    '--accent': vars['--color-accent'],
    '--accent-foreground': vars['--color-base-content'],
    '--muted': vars['--color-neutral'],
    '--muted-foreground': formatOklch(mutedForeground),
    '--destructive': vars['--color-error'],
    '--destructive-foreground': vars['--color-error-content'],
    '--border': vars['--color-base-300'],
    '--input': vars['--color-base-300'],
    '--ring': vars['--color-primary'],
    '--radius': formatRem(cssLengthToRem(vars['--radius-field'], `${themeName} --radius-field`)),
    // daisyUI v5 themes carry no font tokens: pin the documented OFL defaults
    // (same families the seed derivation records) so vectors and emitters see
    // all three font slots for every corpus item.
    '--font-sans': `"${TIER1_DEFAULT_FONTS.fontPrimary}"`,
    '--font-display': `"${TIER1_DEFAULT_FONTS.fontSecondary}"`,
    '--font-mono': `"${TIER1_DEFAULT_FONTS.fontMono}"`,
  }
}

function formatRem(rem: number): string {
  return `${rem}rem`
}

// ---------------------------------------------------------------------------
// Seeds derivation (shared by daisyUI + tweakcn). Best-effort by design:
// cssVars remain the source of truth for vectors; seeds ride along so every
// corpus item satisfies the corpus schema and can re-expand.
// ---------------------------------------------------------------------------

/** OFL defaults for sources that carry no font tokens (daisyUI v5 themes don't). */
export const TIER1_DEFAULT_FONTS: Tier1Fonts = {
  fontPrimary: 'Inter',
  fontSecondary: 'Source Serif 4',
  fontMono: 'JetBrains Mono',
}

/**
 * Exact-match OFL substitutes for families tier-1 sources name. Data, not
 * heuristics: stack leaders are looked up verbatim; unknown families throw.
 * Non-OFL/system entries map to metrically-reasonable OFL families.
 */
export const TIER1_FONT_SUBSTITUTES: Record<string, string> = {
  Inter: 'Inter',
  'Geist': 'Geist',
  'Geist Mono': 'Geist Mono',
  'DM Sans': 'DM Sans',
  'Fira Code': 'Fira Code',
  'IBM Plex Mono': 'IBM Plex Mono',
  'JetBrains Mono': 'JetBrains Mono',
  Lora: 'Lora',
  Montserrat: 'Montserrat',
  'Open Sans': 'Open Sans',
  Outfit: 'Outfit',
  Oxanium: 'Oxanium',
  'Playfair Display': 'Playfair Display',
  'Plus Jakarta Sans': 'Plus Jakarta Sans',
  Poppins: 'Poppins',
  Quicksand: 'Quicksand',
  'Roboto Mono': 'Roboto Mono',
  'Source Code Pro': 'Source Code Pro',
  'Source Serif 4': 'Source Serif 4',
  'Space Mono': 'Space Mono',
  'Ubuntu Mono': 'Ubuntu Mono',
  // system / non-OFL entries -> pinned OFL substitutes
  Roboto: 'Inter',
  'Libre Baskerville': 'Libre Baskerville',
  Merriweather: 'Merriweather',
  Georgia: 'Source Serif 4',
  Menlo: 'JetBrains Mono',
  monospace: 'JetBrains Mono',
  'ui-sans-serif': 'Inter',
  'ui-serif': 'Source Serif 4',
  'ui-monospace': 'JetBrains Mono',
}

/** First family from a CSS font shorthand stack (quotes stripped). */
export function firstNamedFamily(stack: string): string {
  const first = String(stack).split(',')[0]?.trim() ?? ''
  const family = /^"(.*)"$/.exec(first)?.[1] ?? first
  if (!family) throw new Error(`cannot parse font family from stack: "${stack}"`)
  return family
}

/** Substitute one family for an OFL-shippable one. Throws loud on unknowns. */
export function substituteOflFont(family: string): string {
  const sub = TIER1_FONT_SUBSTITUTES[family]
  if (!sub) {
    throw new Error(
      `unknown font family "${family}" — add an OFL substitute to TIER1_FONT_SUBSTITUTES (corpus/mapping.ts) before ingesting`,
    )
  }
  return sub
}

function fontsFromStacks(sansStack: string, serifStack: string, monoStack: string): Tier1Fonts {
  return {
    fontPrimary: substituteOflFont(firstNamedFamily(sansStack)),
    fontSecondary: substituteOflFont(firstNamedFamily(serifStack)),
    fontMono: substituteOflFont(firstNamedFamily(monoStack)),
  }
}

function trackingCurveFromEm(emValue: string | undefined): BrandSeeds['fluidScale']['trackingCurve'] {
  if (emValue === undefined) return 'neutral'
  const match = /^(-?\d*\.?\d+)em$/.exec(String(emValue).trim())
  if (!match) throw new Error(`cannot parse tracking value: "${emValue}"`)
  const em = Number(match[1])
  if (em < 0) return 'negative-on-display'
  if (em > 0) return 'positive-on-display'
  return 'neutral'
}

/**
 * Derive the full seed block from mapped shadcn-shaped cssVars + source hints.
 * Rules (all pinned, documented):
 *  - seedColor: most-chromatic of primary/secondary/accent (tie: primary > secondary > accent).
 *  - neutralTintHue: hue of the muted color (0 when achromatic).
 *  - accentHueShift: null — tier-1 sources carry no chart-hue data; the expand
 *    default (24°) applies by contract, not by silent guessing.
 *  - chromaCurve: max chroma < 0.06 → 'muted'; else chroma spread < 0.3 → 'flat'; else 'tailwind'.
 *  - shapeCharacter from radius rem: ≤0.05 sharp, ≤0.75 soft, else pill.
 *  - fonts: from named stacks when the source has them, else TIER1_DEFAULT_FONTS.
 *  - type scale / space rhythm / motion: pinned neutral defaults (sources carry no data).
 *  - elevation/grain/tracking: from source hints when provided, else pinned.
 */
export function deriveSeedsFromShadcnVars({
  cssVars,
  fontStacks = null,
  elevation = 'subtle',
  grain = 0,
  trackingEm,
}: {
  cssVars: Record<string, string>
  fontStacks?: FontStacks | null
  elevation?: BrandSeeds['elevation']
  grain?: number
  trackingEm?: string
}): BrandSeeds {
  const roles = ['primary', 'secondary', 'accent']
  const chroma = Object.fromEntries(roles.map((r) => [r, parseOklch(cssVars[`--${r}`], r).c] as const))
  const seedRole = roles.sort((a, b) => chroma[b] - chroma[a] || roles.indexOf(a) - roles.indexOf(b))[0]
  const seedColor = parseOklch(cssVars[`--${seedRole}`], seedRole)
  const neutralTint = parseOklch(cssVars['--muted'], 'muted')

  const maxC = Math.max(...roles.map((r) => chroma[r]))
  const minC = Math.min(...roles.map((r) => chroma[r]))
  const chromaCurve = maxC < 0.06 ? 'muted' : (maxC - minC) / maxC < 0.3 ? 'flat' : 'tailwind'

  const radiusRem = cssLengthToRem(cssVars['--radius'], '--radius')
  const shapeCharacter = radiusRem <= 0.05 ? 'sharp' : radiusRem <= 0.75 ? 'soft' : 'pill'

  const fonts = fontStacks ? fontsFromStacks(fontStacks.sans, fontStacks.serif, fontStacks.mono) : { ...TIER1_DEFAULT_FONTS }

  return {
    seedColor,
    neutralTintHue: neutralTint.h,
    accentHueShift: null,
    chromaCurve,
    darkModeStrategy: 'invert-tone',
    fonts,
    fluidScale: {
      baseSize: { min: 16, max: 18 },
      scaleRatio: { min: 1.125, max: 1.25 },
      viewport: { min: 400, max: 1200 },
      scaleSteps: 6,
      trackingCurve: trackingCurveFromEm(trackingEm),
    },
    spaceRhythm: [0.25, 0.5, 1, 2, 4],
    shapeCharacter,
    radiusBase: formatRem(radiusRem),
    elevation,
    motionPersonality: 'productive',
    grain,
    imageryDirection: undefined,
  }
}

// ---------------------------------------------------------------------------
// Corpus item builders (pure: data in → plain item object out).
// ---------------------------------------------------------------------------

/**
 * Build a corpus item from one daisyUI theme.
 * provenance: { source: 'tier1', url: daisyUI docs, note: theme name + package version }.
 */
export function daisyUiThemeToItem({ themeName, cssText, packageVersion }: { themeName: string; cssText: string; packageVersion: string }): BrandCorpusItem {
  const { vars } = parseDaisyUiThemeCss(cssText, themeName)
  const cssVars = mapDaisyUiVarsToShadcn(vars, themeName)
  const seeds = deriveSeedsFromShadcnVars({
    cssVars,
    fontStacks: null,
    elevation: vars['--depth'] === '0' ? 'flat' : 'subtle',
    grain: vars['--noise'] === '1' ? 0.08 : 0,
  })
  const slug = corpusSlug('daisyui', themeName)
  return {
    id: deterministicUuid(slug),
    name: daisyUiDisplayName(themeName),
    seeds,
    cssVars,
    darkCssVars: {}, // daisyUI themes are single-scheme: the theme IS the palette.
    provenance: {
      source: 'tier1',
      url: 'https://daisyui.com/docs/themes/',
      note: `daisyUI theme: ${themeName} (daisyui@${packageVersion})`,
    },
    createdAt: BUILD_EPOCH,
  }
}

/** daisyUI theme ids like "caramellatte" display as "Caramellatte". */
function daisyUiDisplayName(themeName: string): string {
  return `daisyUI ${themeName
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')}`
}

/**
 * Build a corpus item from one tweakcn registry preset (shadcn registry-item
 * JSON: cssVars.theme (fonts, radius, tracking), cssVars.light, cssVars.dark).
 * Throws loud per item on missing data — the ingest script skips + logs.
 */
export function tweakcnPresetToItem(preset: TweakcnPreset, sourceUrl: string): BrandCorpusItem {
  const theme = preset.cssVars?.theme ?? {}
  const light = preset.cssVars?.light ?? {}
  const dark = preset.cssVars?.dark ?? {}
  const roles = ['background', 'foreground', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'accent', 'accent-foreground', 'muted', 'muted-foreground', 'border', 'input', 'ring', 'card', 'card-foreground', 'destructive', 'destructive-foreground']
  const missing = roles.filter((role) => !(role in light))
  const missingDark = roles.filter((role) => !(role in dark))
  if (missing.length > 0 || missingDark.length > 0) {
    throw new Error(`tweakcn preset "${preset.name}": missing cssVars (light: ${missing.join(', ') || 'ok'}; dark: ${missingDark.join(', ') || 'ok'})`)
  }
  const radius = theme.radius
  if (typeof radius !== 'string') {
    throw new Error(`tweakcn preset "${preset.name}": missing radius in cssVars.theme`)
  }

  const dash = (key: string): string => `--${key}`
  const cssVars = Object.fromEntries(Object.entries(light).map(([k, v]) => [dash(k), v] as const))
  const darkCssVars = Object.fromEntries(Object.entries(dark).map(([k, v]) => [dash(k), v] as const))
  cssVars['--radius'] = radius
  // Registry stacks may name system/non-OFL families ("ui-sans-serif, ...").
  // Per V4, cssVars carry the OFL-substituted families (quoted, expand()-style)
  // so the corpus is always shippable; the raw stacks stay in the registry.
  const sans = theme['font-sans']
  const serif = theme['font-serif']
  const mono = theme['font-mono']
  if (!sans || !serif || !mono) {
    throw new Error(`tweakcn preset "${preset.name}": missing font tokens in cssVars.theme`)
  }
  const fonts = fontsFromStacks(sans, serif, mono)
  cssVars['--font-sans'] = `"${fonts.fontPrimary}"`
  cssVars['--font-display'] = `"${fonts.fontSecondary}"`
  cssVars['--font-mono'] = `"${fonts.fontMono}"`

  const seeds = deriveSeedsFromShadcnVars({
    cssVars,
    fontStacks: { sans, serif, mono },
    elevation: 'subtle', // registry carries no shadow recipes; shadcn components ship subtle elevation
    grain: 0,
    trackingEm: theme['tracking-normal'],
  })
  const slug = corpusSlug('tweakcn', preset.name)
  return {
    id: deterministicUuid(slug),
    name: preset.title ?? preset.name,
    seeds,
    cssVars,
    darkCssVars,
    provenance: {
      source: 'tier1',
      url: sourceUrl,
      note: `tweakcn preset: ${preset.name}`,
    },
    createdAt: BUILD_EPOCH,
  }
}
