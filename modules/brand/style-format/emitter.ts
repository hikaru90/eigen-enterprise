/**
 * Deterministic CSS emitter: custom-property records -> a css text block.
 * Keys are sorted so identical token sets always render byte-identical text.
 */
export function toCssText(cssVars: Record<string, string>, selector: string): string {
  const lines = Object.keys(cssVars)
    .sort()
    .map((key) => `  ${key}: ${cssVars[key]};`)
  return [`${selector} {`, ...lines, '}', ''].join('\n')
}

/**
 * The global token override for an ACTIVE visual set (phase-2d M5/V9): a
 * `:root` block, plus a `.dark` block when the set carries dark tokens.
 * Emitted as one unlayered stylesheet so it wins the cascade against the
 * app's layered `@layer base` :root declarations at equal specificity, and —
 * for the app's unlayered `.dark` block — lands after the bundled CSS in
 * document order (SvelteKit renders manifest stylesheets before the root
 * layout's head content). Deterministic: identical tokens, identical text.
 */
export function activeVisualSetCss(
  cssVars: Record<string, string>,
  darkCssVars: Record<string, string> | null,
): string {
  const root = toCssText(cssVars, ':root')
  if (!darkCssVars || Object.keys(darkCssVars).length === 0) return root
  return root + toCssText(darkCssVars, '.dark')
}

/**
 * The override wrapped in exactly one <style> element for injection from the
 * root layout's <svelte:head> (via {@html} — the content is emitter output
 * over owner-approved tokens, never user input).
 */
export function activeVisualSetStyleTag(
  cssVars: Record<string, string>,
  darkCssVars: Record<string, string> | null,
): string {
  return `<style>\n${activeVisualSetCss(cssVars, darkCssVars)}</style>`
}

/**
 * Shell aliases for an active set (C3, brand-wide): the visual sets carry the
 * semantic shadcn roles, never the app-only ones, so without these the
 * sidebar, headings, overlays and shadows kept the app's own neutrals while
 * the set was active. Every alias is derived from the set's own roles and is
 * emitted only when the set does not declare that key itself:
 *  - `--sidebar*`  → the set's background/foreground/primary/accent/border/ring
 *    (the sidebar is tinted 6% toward primary so the chosen colour reads in the
 *    chrome); declared as var() references in :root so a `.dark` block that
 *    redefines the roles re-derives them,
 *  - `--font-heading` → the set's display font (headings use it),
 *  - `--overlay` → a dark tint of the primary (dialog/drawer scrims),
 *  - `--theme-color` → the set's background (status bar of the browser / installed app),
 *  - `--shadow-1..3: none` when the set has no elevation tokens (flat).
 * Font fallback stacks come from the component set (withFontFallbacks).
 * Default app (no active set): none of this is emitted — the app keeps its own tokens.
 */
export function brandShellVars(cssVars: Record<string, string>): Record<string, string> {
  const aliases: Record<string, string> = {
    '--sidebar': 'color-mix(in oklab, var(--primary) 6%, var(--background))',
    '--sidebar-foreground': 'var(--foreground)',
    '--sidebar-primary': 'var(--primary)',
    '--sidebar-primary-foreground': 'var(--primary-foreground)',
    '--sidebar-accent': 'color-mix(in oklab, var(--primary) 14%, var(--background))',
    '--sidebar-accent-foreground': 'var(--foreground)',
    '--sidebar-border': 'var(--border)',
    '--sidebar-ring': 'var(--ring)',
    '--font-heading': 'var(--font-display)',
    '--overlay': 'color-mix(in oklab, var(--primary) 20%, black)',
    // The root layout copies it into <meta name="theme-color"> (browser and installed-app status bar).
    '--theme-color': 'var(--background)',
  }
  if (!('--shadow-1' in cssVars)) {
    aliases['--shadow-1'] = 'none'
    aliases['--shadow-2'] = 'none'
    aliases['--shadow-3'] = 'none'
  }
  return { ...aliases, ...cssVars }
}
