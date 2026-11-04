import { formatHex, parse } from 'culori'

/**
 * The Brand inside email (plan/phase-polish-1.md P-6: layouts use ee's Brand
 * instead of Owlery's design systems). Email clients understand neither CSS
 * variables nor oklch, so the active visual set's tokens are resolved to hex
 * colours and plain font stacks, available as `{{ brand.* }}` in layouts and
 * templates. With no active set the app's own style applies — the same rule
 * as the rest of the app (an active set is the only way to restyle).
 */

export type EmailBrand = {
  /** Where the tokens came from (shown on the Layouts page). */
  source: 'visual_set' | 'app_default'
  /** Null until the company is named; then {{ brand.companyName }} counts as a missing variable. */
  companyName: string | null
  tokens: Record<string, string>
}

/** The app's own light tokens (src/routes/layout.css :root) — used when no brand set is active. */
export const APP_DEFAULT_TOKENS: Record<string, string> = {
  primary: '#111111',
  primaryForeground: '#ffffff',
  background: '#e8ede5',
  surface: '#ffffff',
  foreground: '#111111',
  muted: '#f0f3f0',
  mutedForeground: '#6b6b6b',
  border: '#e2e2e2',
  font: "Inter, 'Helvetica Neue', Arial, sans-serif",
  headingFont: "Inter, 'Helvetica Neue', Arial, sans-serif",
  radius: '4px',
}

/** Token name in templates → the visual set's CSS custom property. */
const COLOR_VARS: Record<string, string> = {
  primary: '--primary',
  primaryForeground: '--primary-foreground',
  background: '--background',
  surface: '--card',
  foreground: '--foreground',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  border: '--border',
}

function hex(value: string | undefined): string | null {
  if (!value) return null
  const c = parse(value)
  return c ? formatHex(c) : null
}

function fontStack(value: string | undefined): string | null {
  if (!value?.trim()) return null
  return `${value.trim()}, 'Helvetica Neue', Arial, sans-serif`
}

/**
 * Resolves a visual set's css variables into email-safe tokens. An active set
 * always carries every colour role (REQUIRED_VISUAL_ROLES), so a missing or
 * unreadable colour is an error, never a quiet substitute. Fonts and radius
 * are taken when the set declares them.
 */
export function emailBrandFromCssVars(cssVars: Record<string, string> | null, companyName: string | null): EmailBrand {
  if (!cssVars) return { source: 'app_default', companyName, tokens: { ...APP_DEFAULT_TOKENS } }
  const tokens: Record<string, string> = { ...APP_DEFAULT_TOKENS }
  for (const [name, cssVar] of Object.entries(COLOR_VARS)) {
    const v = hex(cssVars[cssVar])
    if (!v) throw new Error(`The active brand set has no readable ${cssVar} colour (got ${JSON.stringify(cssVars[cssVar] ?? null)})`)
    tokens[name] = v
  }
  tokens.font = fontStack(cssVars['--font-sans']) ?? tokens.font!
  tokens.headingFont = fontStack(cssVars['--font-display']) ?? tokens.font
  const radius = cssVars['--radius']?.trim()
  if (radius) tokens.radius = radius.endsWith('rem') ? `${Math.round(parseFloat(radius) * 16)}px` : radius
  return { source: 'visual_set', companyName, tokens }
}

/** `brand.<token>` placeholder values (plus brand.companyName). */
export function brandValues(brand: EmailBrand): Record<string, string> {
  const out: Record<string, string> = brand.companyName ? { 'brand.companyName': brand.companyName } : {}
  for (const [k, v] of Object.entries(brand.tokens)) out[`brand.${k}`] = v
  return out
}
