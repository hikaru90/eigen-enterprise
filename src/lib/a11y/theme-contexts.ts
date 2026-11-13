/**
 * The token records the app's theme is composed into (no active brand set),
 * read from src/routes/layout.css. Shared by the theme contrast spec and the
 * page-level style guard so both measure the same colours.
 */

/**
 * The custom-property declarations of the first block whose line starts with
 * `selector {` (so `.dark {` never matches `:root.dark {`); no nested rules inside.
 */
export function cssBlock(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = css.search(new RegExp(`^[ \\t]*${escaped} \\{`, 'm'))
  if (start < 0) throw new Error(`layout.css has no "${selector} {" block`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const body = css.slice(open + 1, close)
  if (body.includes('{')) throw new Error(`"${selector}" block has nested rules`)
  const vars: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim()
  return vars
}

/** layout.css with comments stripped (they may contain braces). */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Where the tokens are composed: signed-out pages read :root (light) or
 * :root + .dark; the signed-in nucleus pins its subtree with
 * .marketing-light-theme, which in OS dark mode sits on top of .dark — so any
 * role the wrapper does not re-declare leaks the dark value into the light page.
 */
export function themeContexts(css: string): Record<string, Record<string, string>> {
  const root = cssBlock(css, ':root')
  const dark = cssBlock(css, '.dark')
  const marketing = cssBlock(css, '.marketing-light-theme')
  return {
    'signed-out, light': root,
    'signed-out, dark': { ...root, ...dark },
    'nucleus, light': { ...root, ...marketing },
    'nucleus, OS dark mode': { ...root, ...dark, ...marketing },
  }
}
