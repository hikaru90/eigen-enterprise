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
