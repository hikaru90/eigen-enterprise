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
