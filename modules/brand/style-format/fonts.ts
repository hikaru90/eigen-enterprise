/**
 * Exact-match font classification for the style vector (phase-2d M3, V6).
 *
 * Typography enters the similarity math as a categorical class per font slot
 * (sans | serif | mono | display). Classification is an exact-name lookup over
 * this pinned table — never substring/keyword guessing (AGENTS.md: no string
 * heuristics for meaning). A family missing from the table is a build-time
 * loud error: extend the table with the family's true class, review the
 * corpus diff, commit.
 *
 * Every family listed here is OFL (or substituted to OFL downstream by
 * modules/brand/corpus/mapping.mjs before it can reach a corpus item).
 */

export type FontClass = 'sans' | 'serif' | 'mono' | 'display'

export const FONT_CLASS_TABLE: Record<string, FontClass> = {
  // sans
  Inter: 'sans',
  Geist: 'sans',
  'DM Sans': 'sans',
  'Open Sans': 'sans',
  Montserrat: 'sans',
  Poppins: 'sans',
  Outfit: 'sans',
  'Plus Jakarta Sans': 'sans',
  Quicksand: 'sans',
  Roboto: 'sans',
  'Work Sans': 'sans',
  Manrope: 'sans',
  Archivo: 'sans',
  Sora: 'sans',
  Nunito: 'sans',
  Oxanium: 'sans',
  // serif
  'Source Serif 4': 'serif',
  'Libre Baskerville': 'serif',
  Lora: 'serif',
  Merriweather: 'serif',
  'Playfair Display': 'serif',
  'Cormorant Garamond': 'serif',
  Newsreader: 'serif',
  // mono
  'JetBrains Mono': 'mono',
  'Fira Code': 'mono',
  'Geist Mono': 'mono',
  'IBM Plex Mono': 'mono',
  'Roboto Mono': 'mono',
  'Space Mono': 'mono',
  'Ubuntu Mono': 'mono',
  'Source Code Pro': 'mono',
  // display
  'Space Grotesk': 'display',
  Fraunces: 'display',
  'Instrument Serif': 'display',
}

/**
 * Classify one font family by exact table lookup. Throws loud on unknown
 * families — extend FONT_CLASS_TABLE instead of guessing.
 */
export function classifyFontFamily(family: string): FontClass {
  const cls = FONT_CLASS_TABLE[family]
  if (!cls) {
    throw new Error(
      `unknown font family "${family}" — add it to FONT_CLASS_TABLE (style-format/fonts.ts) with its true class before it enters the corpus`,
    )
  }
  return cls
}

/**
 * Distance matrix over font classes (symmetric, 0 diagonal). Coarse ordering:
 * mono is furthest from everything (terminal idiom), display sits nearest
 * sans, serif/display share editorial DNA.
 */
export const FONT_CLASS_DISTANCE: Record<FontClass, Record<FontClass, number>> = {
  sans: { sans: 0, serif: 0.5, mono: 0.75, display: 0.25 },
  serif: { sans: 0.5, serif: 0, mono: 0.75, display: 0.5 },
  mono: { sans: 0.75, serif: 0.75, mono: 0, display: 0.75 },
  display: { sans: 0.25, serif: 0.5, mono: 0.75, display: 0 },
}
