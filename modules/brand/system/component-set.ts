/**
 * The design-system component set (phase brand-picker, B4 §3.4): the ONE
 * explicit list of what the chosen style drives, and the pure helpers the
 * `/brand/system` view uses to render it in the active visual set's tokens.
 *
 * Every entry names the shadcn component under `src/lib/components/ui/` that
 * renders it — the view composes the app's own components, never parallel
 * look-alikes, so what the view shows is what the console shows.
 */

import { toCssText } from '../style-format/emitter'
import { FONT_CLASS_TABLE, type FontClass } from '../style-format/fonts'

export type ComponentGroup =
  'actions' | 'forms' | 'surfaces' | 'navigation' | 'data' | 'foundations'

export type ComponentEntry = {
  id: string
  label: string
  group: ComponentGroup
  /** The app's shadcn component(s) under src/lib/components/ui/ that render it (empty = pure tokens). */
  uses: readonly string[]
  /** The variants/states the view must show. */
  variants: readonly string[]
}

export const BUTTON_VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive'] as const
export const BUTTON_SIZES = ['sm', 'default', 'lg'] as const

export const COMPONENT_SET: readonly ComponentEntry[] = [
  {
    id: 'button',
    label: 'Buttons',
    group: 'actions',
    uses: ['button'],
    variants: [...BUTTON_VARIANTS, ...BUTTON_SIZES.map((s) => `size:${s}`), 'disabled'],
  },
  {
    id: 'input',
    label: 'Input',
    group: 'forms',
    uses: ['input', 'label'],
    variants: ['default', 'disabled'],
  },
  {
    id: 'textarea',
    label: 'Textarea',
    group: 'forms',
    uses: ['textarea', 'label'],
    variants: ['default'],
  },
  {
    id: 'select',
    label: 'Select',
    group: 'forms',
    uses: ['select', 'label'],
    variants: ['closed'],
  },
  {
    id: 'checkbox-switch',
    label: 'Checkbox & switch',
    group: 'forms',
    uses: ['checkbox', 'switch', 'label'],
    variants: ['checked', 'unchecked'],
  },
  { id: 'card', label: 'Card', group: 'surfaces', uses: ['card'], variants: ['default'] },
  {
    id: 'badge',
    label: 'Badges',
    group: 'surfaces',
    uses: ['badge'],
    variants: ['default', 'secondary', 'outline', 'destructive'],
  },
  {
    id: 'alert',
    label: 'Alerts',
    group: 'surfaces',
    uses: ['alert'],
    variants: ['default', 'destructive'],
  },
  {
    id: 'dialog',
    label: 'Dialog',
    group: 'surfaces',
    uses: ['dialog', 'button'],
    variants: ['open (static preview)'],
  },
  { id: 'tabs', label: 'Tabs', group: 'navigation', uses: ['tabs'], variants: ['default'] },
  {
    id: 'nav',
    label: 'Nav bar',
    group: 'navigation',
    uses: ['button', 'breadcrumb'],
    variants: ['current', 'idle'],
  },
  { id: 'table', label: 'Table', group: 'data', uses: ['table', 'badge'], variants: ['default'] },
  {
    id: 'typography',
    label: 'Typography scale',
    group: 'foundations',
    uses: [],
    variants: ['display', 'h1', 'h2', 'h3', 'h4', 'body', 'small', 'mono'],
  },
  { id: 'colors', label: 'Colour roles', group: 'foundations', uses: [], variants: ['swatches'] },
  {
    id: 'radius',
    label: 'Radius',
    group: 'foundations',
    uses: [],
    variants: ['sm', 'md', 'lg', 'xl'],
  },
  { id: 'shadow', label: 'Shadow', group: 'foundations', uses: [], variants: ['1', '2', '3'] },
]

export type TypeStep = {
  id: 'display' | 'h1' | 'h2' | 'h3' | 'h4' | 'body' | 'small' | 'mono'
  label: string
  /** Which font role sets it. */
  font: 'display' | 'sans' | 'mono'
  /** Tailwind classes (size/weight/leading) — the font comes from the role utility. */
  className: string
  /** The HTML element the step renders as. */
  tag: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'code'
}

export const TYPE_SCALE: readonly TypeStep[] = [
  {
    id: 'display',
    label: 'Display',
    font: 'display',
    tag: 'p',
    className: 'text-5xl leading-none tracking-tight',
  },
  {
    id: 'h1',
    label: 'Heading 1',
    font: 'display',
    tag: 'h1',
    className: 'text-4xl leading-tight tracking-tight',
  },
  { id: 'h2', label: 'Heading 2', font: 'display', tag: 'h2', className: 'text-3xl leading-tight' },
  { id: 'h3', label: 'Heading 3', font: 'sans', tag: 'h3', className: 'text-xl font-semibold' },
  { id: 'h4', label: 'Heading 4', font: 'sans', tag: 'h4', className: 'text-base font-semibold' },
  { id: 'body', label: 'Body', font: 'sans', tag: 'p', className: 'text-sm leading-relaxed' },
  {
    id: 'small',
    label: 'Small',
    font: 'sans',
    tag: 'p',
    className: 'text-xs text-muted-foreground',
  },
  { id: 'mono', label: 'Mono', font: 'mono', tag: 'code', className: 'text-sm' },
]

/** Background roles and the foreground each pairs with (null = a line/surface role). */
export const COLOR_ROLES: readonly { role: string; on: string | null }[] = [
  { role: 'background', on: 'foreground' },
  { role: 'card', on: 'card-foreground' },
  { role: 'popover', on: 'popover-foreground' },
  { role: 'primary', on: 'primary-foreground' },
  { role: 'secondary', on: 'secondary-foreground' },
  { role: 'muted', on: 'muted-foreground' },
  { role: 'accent', on: 'accent-foreground' },
  { role: 'destructive', on: null },
  { role: 'border', on: null },
  { role: 'input', on: null },
  { role: 'ring', on: null },
]

export const RADIUS_SAMPLES = ['sm', 'md', 'lg', 'xl'] as const
export const SHADOW_SAMPLES = ['--shadow-1', '--shadow-2', '--shadow-3'] as const

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export const FONT_ROLES = ['--font-display', '--font-sans', '--font-mono'] as const
type FontRole = (typeof FONT_ROLES)[number]

/** CSS generic family keywords (exact list) — never fetched from Google Fonts. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
])

const FALLBACK_BY_CLASS: Record<FontClass, string> = {
  sans: 'ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, serif',
  display: 'ui-serif, Georgia, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const FALLBACK_BY_ROLE: Record<FontRole, FontClass> = {
  '--font-display': 'serif',
  '--font-sans': 'sans',
  '--font-mono': 'mono',
}

/** Split a font-family value into its families (quotes stripped). */
export function fontFamilies(value: string): string[] {
  return value
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim(),
    )
    .filter((part) => part.length > 0)
}

/** The leading (brand) family of a font-family value, or null when it is only generics. */
export function primaryFamily(value: string): string | null {
  const [first] = fontFamilies(value)
  return first && !GENERIC_FAMILIES.has(first) ? first : null
}

/**
 * A font stack that always ends in generic fallbacks: the brand family first,
 * then the fallback for its class (exact FONT_CLASS_TABLE lookup; an unknown
 * family takes its role's class). Values that already end in a generic stay.
 */
export function withFontFallback(role: FontRole, value: string): string {
  const families = fontFamilies(value)
  if (families.length > 0 && GENERIC_FAMILIES.has(families[families.length - 1])) return value
  const lead = primaryFamily(value)
  const cls = (lead ? FONT_CLASS_TABLE[lead] : undefined) ?? FALLBACK_BY_ROLE[role]
  return `${value.trim()}, ${FALLBACK_BY_CLASS[cls]}`
}

/**
 * One Google Fonts stylesheet link per distinct brand family of the active
 * set's font roles (display, sans, mono). One link per family on purpose: an
 * unknown family 400s only its own link instead of the whole stylesheet.
 */
export function googleFontLinks(
  cssVars: Record<string, string>,
): { family: string; href: string }[] {
  const seen = new Set<string>()
  const links: { family: string; href: string }[] = []
  for (const role of FONT_ROLES) {
    const value = cssVars[role]
    if (!value) continue
    const family = primaryFamily(value)
    if (!family || seen.has(family)) continue
    seen.add(family)
    links.push({
      family,
      href: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}&display=swap`,
    })
  }
  return links
}

// ---------------------------------------------------------------------------
// Scoped token CSS (the page-local light/dark switch)
// ---------------------------------------------------------------------------

export const SYSTEM_SCOPE_ATTR = 'data-system-theme'

/**
 * The doubled attribute gives specificity (0,2,0): the dark scope carries the
 * `.dark` class (so shadcn `dark:` utilities fire inside it), and the app's
 * own unlayered `.dark { --primary: … }` block (0,1,0) must not beat the
 * brand's dark tokens on that same element.
 */
function scopeSelector(mode: 'light' | 'dark'): string {
  return `[${SYSTEM_SCOPE_ATTR}][${SYSTEM_SCOPE_ATTR}='${mode}']`
}

/** Every font role of a token record with its generic fallback stack appended. */
export function withFontFallbacks(vars: Record<string, string>): Record<string, string> {
  const out = { ...vars }
  for (const role of FONT_ROLES) {
    if (out[role]) out[role] = withFontFallback(role, out[role])
  }
  return out
}

/**
 * The active set's tokens re-declared on the view's own area so its light/dark
 * switch is page-scoped (independent of the app theme): light =
 * cssVars, dark = cssVars overlaid with darkCssVars (a set without dark tokens
 * shows its light tokens in both). Same emitter as the global :root override.
 */
export function systemScopeCss(
  cssVars: Record<string, string>,
  darkCssVars: Record<string, string> | null,
): string {
  const light = withFontFallbacks(cssVars)
  const dark = withFontFallbacks({ ...cssVars, ...(darkCssVars ?? {}) })
  return (
    toCssText({ ...light, 'color-scheme': 'light' }, scopeSelector('light')) +
    toCssText({ ...dark, 'color-scheme': 'dark' }, scopeSelector('dark'))
  )
}
