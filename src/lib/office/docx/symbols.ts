/**
 * Symbol fonts. Word stores characters of the Symbol and Wingdings fonts
 * (w:sym, bullet lvlText) as code points in those fonts' own encodings, often
 * moved into the Private Use Area (U+F000 + code). Where the font's glyph has
 * a Unicode equivalent we show that, so it renders without the font; other
 * codes stay as written, in the named font.
 */

const SYMBOL: Record<number, string> = {
  0x22: '∀', 0x24: '∃', 0x27: '∋', 0x2d: '−', 0x40: '≅',
  0x41: 'Α', 0x42: 'Β', 0x43: 'Χ', 0x44: 'Δ', 0x45: 'Ε', 0x46: 'Φ', 0x47: 'Γ', 0x48: 'Η', 0x49: 'Ι', 0x4b: 'Κ',
  0x4c: 'Λ', 0x4d: 'Μ', 0x4e: 'Ν', 0x4f: 'Ο', 0x50: 'Π', 0x51: 'Θ', 0x52: 'Ρ', 0x53: 'Σ', 0x54: 'Τ', 0x55: 'Υ',
  0x57: 'Ω', 0x58: 'Ξ', 0x59: 'Ψ', 0x5a: 'Ζ', 0x5e: '⊥',
  0x61: 'α', 0x62: 'β', 0x63: 'χ', 0x64: 'δ', 0x65: 'ε', 0x66: 'φ', 0x67: 'γ', 0x68: 'η', 0x69: 'ι', 0x6a: 'ϕ',
  0x6b: 'κ', 0x6c: 'λ', 0x6d: 'μ', 0x6e: 'ν', 0x6f: 'ο', 0x70: 'π', 0x71: 'θ', 0x72: 'ρ', 0x73: 'σ', 0x74: 'τ',
  0x75: 'υ', 0x76: 'ϖ', 0x77: 'ω', 0x78: 'ξ', 0x79: 'ψ', 0x7a: 'ζ', 0x7e: '∼',
  0xa3: '≤', 0xa5: '∞', 0xa7: '♣', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠', 0xab: '↔', 0xac: '←', 0xad: '↑', 0xae: '→',
  0xaf: '↓', 0xb0: '°', 0xb1: '±', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•', 0xb8: '÷', 0xb9: '≠',
  0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪', 0xd1: '∇', 0xd2: '®', 0xd3: '©',
  0xd4: '™', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅', 0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔', 0xdc: '⇐', 0xde: '⇒',
  0xe0: '◊', 0xe5: '∑', 0xf2: '∫',
}

const WINGDINGS: Record<number, string> = {
  0x4a: '☺', 0x4c: '☹', 0x6c: '●', 0x6e: '■', 0x6f: '□', 0x71: '❑', 0x75: '◆', 0x76: '❖',
  0x9f: '•', 0xa1: '○', 0xa7: '▪', 0xa8: '◻', 0xd8: '➢', 0xe0: '➔', 0xe8: '➔', 0xef: '⇦', 0xf0: '⇨',
  0xfb: '✗', 0xfc: '✓', 0xfd: '☒', 0xfe: '☑',
}

const TABLES: Record<string, Record<number, string>> = {
  symbol: SYMBOL,
  wingdings: WINGDINGS,
}

/** The character to show for `code` in `font`; `mapped` says whether it is a Unicode equivalent (font no longer needed). */
export function symbolChar(font: string | null | undefined, code: number): { char: string; mapped: boolean } {
  const table = font ? TABLES[font.trim().toLowerCase()] : undefined
  const low = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code
  const hit = table?.[low]
  if (hit) return { char: hit, mapped: true }
  return { char: String.fromCodePoint(code), mapped: false }
}

/** A bullet's lvlText in its font, mapped the same way character by character. */
export function symbolText(font: string | null | undefined, text: string): { text: string; mapped: boolean } {
  let mapped = false
  let out = ''
  for (const ch of text) {
    const r = symbolChar(font, ch.codePointAt(0)!)
    if (r.mapped) mapped = true
    out += r.char
  }
  return { text: out, mapped }
}
