import { formatHex, parse } from 'culori'
import { PRODUCT_NAME } from './manifest'

/**
 * The installed app's identity, per instance: the company's name and its
 * monogram (initial on the brand's primary color — the same badge the shell's
 * sidebar shows), so two companies installed on one phone are two clearly
 * different apps. Without a name it is the product (static icons); without
 * an active visual set it uses the app's own colors (layout.css :root).
 */

/** The app's own tokens (src/routes/layout.css :root) when no brand is active. */
const APP_TOKENS = { primary: '#111111', primaryForeground: '#ffffff', background: '#e8ede5' }

export type IdentityTokens = {
  name: string
  /** null = unnamed company → the product icons. */
  initial: string | null
  primary: string
  primaryForeground: string
  background: string
  /** Changes whenever the name or colors change, so installed icons refresh. */
  version: string
}

export type IdentityColors = { tile: string; glyph: string; background: string }

/** FNV-1a, base 36 — a cache key, not security. */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function identityTokens(companyName: string | null, cssVars: Record<string, string> | null): IdentityTokens {
  const primary = cssVars?.['--primary'] ?? APP_TOKENS.primary
  const primaryForeground = cssVars?.['--primary-foreground'] ?? APP_TOKENS.primaryForeground
  const background = cssVars?.['--background'] ?? APP_TOKENS.background
  const name = companyName ?? PRODUCT_NAME
  const first = companyName ? Array.from(companyName.trim())[0] : undefined
  const initial = first ? first.toLocaleUpperCase() : null
  return {
    name,
    initial,
    primary,
    primaryForeground,
    background,
    version: shortHash(JSON.stringify([name, initial, primary, primaryForeground, background])),
  }
}

function hex(token: string, value: string): string {
  const color = parse(value)
  if (!color) throw new Error(`brand token ${token} is not a color: "${value}"`)
  return formatHex(color)
}

export function identityColors(t: IdentityTokens): IdentityColors {
  return {
    tile: hex('--primary', t.primary),
    glyph: hex('--primary-foreground', t.primaryForeground),
    background: hex('--background', t.background),
  }
}

export type IconKind = 'any' | 'maskable' | 'apple'
export type IconVariant = { kind: IconKind; size: number }

const VARIANTS: Record<string, IconVariant> = {
  'any-192.png': { kind: 'any', size: 192 },
  'any-512.png': { kind: 'any', size: 512 },
  'maskable-512.png': { kind: 'maskable', size: 512 },
  'apple-180.png': { kind: 'apple', size: 180 },
  'favicon-32.png': { kind: 'any', size: 32 },
}

/** The icons served at /app-icon/<variant>; anything else is not an icon. */
export function parseIconVariant(name: string): IconVariant | null {
  return Object.hasOwn(VARIANTS, name) ? VARIANTS[name] : null
}
