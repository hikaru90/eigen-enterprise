import {
  AA_TEXT,
  AA_UI,
  pairContrast,
  type ContrastPair,
  type ThemeLayer,
} from '../../../modules/brand/style-format/contrast'

/**
 * Page-level accessibility style audit (Contribute b73604ff, part 2).
 *
 * Part 1 made the theme itself pass WCAG 2.1 AA (src/routes/layout.contrast.spec.ts).
 * This finds the per-page spots that undo it, by reading a Svelte (or TS) source:
 *
 * - `tiny-text`: an explicit size below the 13px floor (`text-[11px]`, `font-size: 0.75rem`).
 * - `faded-text`: a theme text colour with an opacity modifier (`text-foreground/50`)
 *   whose painted contrast falls below 4.5:1 on a surface that token is used on.
 * - `faded-focus`: a focus ring / outline / border in the ring colour with an
 *   opacity modifier (`focus-visible:ring-ring/50`) below 3:1 (SC 1.4.11).
 * - `no-focus-style`: `outline-none` / `outline-hidden` (which beats the global
 *   `:focus-visible` outline) on an element that shows no other focus style.
 *
 * These are mechanical style checks over class names and CSS, not a reading of
 * what the UI means; the token maths is the same as the theme spec's.
 */

export type FindingKind = 'tiny-text' | 'faded-text' | 'faded-focus' | 'no-focus-style'

export type Finding = { kind: FindingKind; match: string; line: number }

/** The token records text is painted under (light, dark, …), keyed by a name for messages. */
export type FadedTextRule = { contexts: Record<string, Record<string, string>> }

/** The smallest text the app allows (layout.css `--text-xs`). */
export const MIN_TEXT_PX = 13

const VARIANTS = String.raw`((?:[\w-]+(?:\[[^\]\s]*\])?:)*)`
const BOUNDARY = String.raw`(?<![\w\-\[\]/.:])`

const TINY_CLASS = new RegExp(
  `${BOUNDARY}${VARIANTS}text-\\[(\\d*\\.?\\d+)(px|rem)\\](?![\\w-])`,
  'g',
)
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/g
const FONT_SIZE = /font-size\s*:\s*(\d*\.?\d+)(px|rem)\b/g
const FADED_CLASS = new RegExp(
  `${BOUNDARY}${VARIANTS}text-([a-z]+(?:-[a-z]+)*)/(\\d+)(?![\\w-])`,
  'g',
)
const FADED_FOCUS = new RegExp(
  `${BOUNDARY}${VARIANTS}(?:ring|outline|border)-ring/(\\d+)(?![\\w-])`,
  'g',
)
const OUTLINE_OFF = new RegExp(`${BOUNDARY}${VARIANTS}outline-(none|hidden)(?![\\w-])`, 'g')

const OWN_FOCUS_STYLE =
  /(?:^|[\s"'`{(])(?:[\w-]+(?:\[[^\]\s]*\])?:)*(?:focus|focus-visible|data-highlighted|data-\[highlighted\])(?::[\w-]+(?:\[[^\]\s]*\])?)*:(?:ring|outline(?!-none|-hidden)|border|bg|shadow|underline|inset-ring)/
const WRAPPER_FOCUS_STYLE =
  /(?:^|[\s"'`{(])(?:[\w-]+(?:\[[^\]\s]*\])?:)*focus-within:(?:ring|outline(?!-none|-hidden)|border|bg|shadow)/
const PROGRAMMATIC_TARGET = /\btabindex=(?:"-1"|'-1'|\{-1\})/

const BG: ThemeLayer[] = [{ token: '--background' }]
const CARD: ThemeLayer[] = [{ token: '--card' }]
const POPOVER: ThemeLayer[] = [{ token: '--popover' }]
const MUTED: ThemeLayer[] = [{ token: '--muted' }]
const PLAIN = [BG, CARD, POPOVER, MUTED]
const fill = (token: `--${string}`): ThemeLayer[][] => [[{ token }]]

/** Theme text colours and the surfaces each is painted on (as in THEME_CONTRAST_PAIRS). */
const TEXT_TOKEN_SURFACES: Record<string, ThemeLayer[][]> = {
  foreground: PLAIN,
  'muted-foreground': PLAIN,
  primary: PLAIN,
  destructive: PLAIN,
  success: PLAIN,
  'card-foreground': [CARD],
  'popover-foreground': [POPOVER],
  'primary-foreground': fill('--primary'),
  'secondary-foreground': fill('--secondary'),
  'accent-foreground': fill('--accent'),
  'sidebar-foreground': fill('--sidebar'),
  'sidebar-primary-foreground': fill('--sidebar-primary'),
  'sidebar-accent-foreground': fill('--sidebar-accent'),
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])

function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

/** Blank out <script>/<style> bodies (keeping offsets) so only markup is parsed as tags. */
function markupOnly(source: string): string {
  return source.replace(
    /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/g,
    (_m, open, _n, body, close) => open + body.replace(/[^\n]/g, ' ') + close,
  )
}

type Tag = { name: string; start: number; end: number; ancestors: Tag[] }

/** Index of the `>` closing the tag that opens at `start`, skipping quotes and `{…}` expressions. */
function tagEnd(markup: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = start + 1; i < markup.length; i++) {
    const c = markup[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return i
  }
  throw new Error(`page-style-audit: unterminated tag at offset ${start}`)
}

function parseTags(markup: string): Tag[] {
  const tags: Tag[] = []
  const stack: Tag[] = []
  for (let i = 0; i < markup.length; i++) {
    if (markup[i] !== '<') continue
    if (markup.startsWith('<!--', i)) {
      const close = markup.indexOf('-->', i)
      i = close < 0 ? markup.length : close + 2
      continue
    }
    const closing = markup.slice(i).match(/^<\/([\w:.-]+)\s*>/)
    if (closing) {
      const at = stack.map((t) => t.name).lastIndexOf(closing[1])
      if (at >= 0) stack.length = at
      i += closing[0].length - 1
      continue
    }
    const open = markup.slice(i).match(/^<([A-Za-z][\w:.-]*)/)
    if (!open) continue
    const end = tagEnd(markup, i)
    const tag: Tag = { name: open[1], start: i, end, ancestors: [...stack] }
    tags.push(tag)
    const selfClosing = markup[end - 1] === '/'
    if (!selfClosing && !VOID.has(open[1].toLowerCase())) stack.push(tag)
    i = end
  }
  return tags
}

const LITERAL_OR_COMMENT =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g

/** [start, end] of every string literal (comments skipped), for class strings built in script. */
function stringLiterals(source: string): [number, number][] {
  const out: [number, number][] = []
  for (const m of source.matchAll(LITERAL_OR_COMMENT)) {
    if (m[0].startsWith('/')) continue
    out.push([m.index, m.index + m[0].length])
  }
  return out
}

function fadedRatio(
  rule: FadedTextRule,
  name: string,
  alpha: number,
  surfaces: ThemeLayer[][] = TEXT_TOKEN_SURFACES[name],
): number {
  let worst = Infinity
  for (const [context, tokens] of Object.entries(rule.contexts)) {
    for (const on of surfaces) {
      for (const layer of [{ token: `--${name}` }, ...on]) {
        if (tokens[layer.token] === undefined) {
          throw new Error(`page-style-audit: context "${context}" does not declare ${layer.token}`)
        }
      }
      const pair: ContrastPair = {
        id: `${name}/${alpha * 100}`,
        fg: { token: `--${name}`, alpha },
        on,
        min: AA_TEXT,
        use: 'page text / focus indicator',
      }
      worst = Math.min(worst, pairContrast(tokens, pair))
    }
  }
  return worst
}

/**
 * Every finding in one source file, in source order. `markup: false` for a
 * plain .ts module: its class strings are checked, but no element is known,
 * so a removed outline there is always reported.
 */
export function auditSource(
  source: string,
  rule: FadedTextRule,
  { markup = true }: { markup?: boolean } = {},
): Finding[] {
  const found: { index: number; kind: FindingKind; match: string }[] = []

  for (const m of source.matchAll(TINY_CLASS)) {
    const px = Number(m[2]) * (m[3] === 'rem' ? 16 : 1)
    if (px < MIN_TEXT_PX) found.push({ index: m.index, kind: 'tiny-text', match: m[0] })
  }
  for (const block of source.matchAll(STYLE_BLOCK)) {
    const offset = block.index + block[0].indexOf(block[1])
    for (const m of block[1].matchAll(FONT_SIZE)) {
      const px = Number(m[1]) * (m[2] === 'rem' ? 16 : 1)
      if (px < MIN_TEXT_PX) {
        found.push({
          index: offset + m.index,
          kind: 'tiny-text',
          match: `font-size: ${m[1]}${m[2]}`,
        })
      }
    }
  }

  for (const m of source.matchAll(FADED_CLASS)) {
    const [match, variants, name, percent] = m
    if (!(name in TEXT_TOKEN_SURFACES)) continue
    if (/disabled/.test(variants)) continue
    const alpha = Number(percent) / 100
    if (alpha >= 1) continue
    if (fadedRatio(rule, name, alpha) < AA_TEXT)
      found.push({ index: m.index, kind: 'faded-text', match })
  }

  for (const m of source.matchAll(FADED_FOCUS)) {
    const [match, variants, percent] = m
    if (!/focus/.test(variants)) continue
    const alpha = Number(percent) / 100
    if (alpha >= 1) continue
    if (fadedRatio(rule, 'ring', alpha, PLAIN) < AA_UI)
      found.push({ index: m.index, kind: 'faded-focus', match })
  }

  const tags = markup ? parseTags(markupOnly(source)) : []
  let literals: [number, number][] | undefined
  for (const m of source.matchAll(OUTLINE_OFF)) {
    const tag = tags.find((t) => t.start < m.index && m.index < t.end)
    if (tag) {
      const text = source.slice(tag.start, tag.end + 1)
      if (OWN_FOCUS_STYLE.test(text) || PROGRAMMATIC_TARGET.test(text)) continue
      if (tag.ancestors.some((a) => WRAPPER_FOCUS_STYLE.test(source.slice(a.start, a.end + 1))))
        continue
    } else {
      // A class string built in script: the string itself must carry the focus style.
      literals ??= stringLiterals(source)
      const literal = literals.find(([start, end]) => start < m.index && m.index < end)
      if (literal && OWN_FOCUS_STYLE.test(source.slice(literal[0], literal[1]))) continue
    }
    found.push({ index: m.index, kind: 'no-focus-style', match: m[0] })
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index, kind, match }) => ({ kind, match, line: lineAt(source, index) }))
}
