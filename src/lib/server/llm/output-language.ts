/**
 * The language a generated text is written in (wish d0a0c775, 2026-11-28: "no weird Chinese
 * characters in summaries"). Root cause: the summary prompts named no output language, so a
 * model that drifts (DeepSeek, Qwen) sometimes slipped words of its own training script into an
 * English or German summary. Every summary prompt now says the language explicitly
 * ({@link outputLanguageInstruction}), and its output is checked before it is stored
 * ({@link assertOutputScript}).
 *
 * The check is structural (Unicode script properties of the letters), never meaning: a letter in
 * a script the language is not written in, and that the source text does not contain either,
 * refuses the output loud (OutputScriptError) instead of storing it.
 */

/** The scripts each language is written in (letters only); a language not listed is written in Latin. */
const LANGUAGE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  zh: ['Han'],
  ja: ['Han', 'Hiragana', 'Katakana'],
  ko: ['Hangul', 'Han'],
  ru: ['Cyrillic'],
  uk: ['Cyrillic'],
  bg: ['Cyrillic'],
  sr: ['Cyrillic', 'Latin'],
  el: ['Greek'],
  ar: ['Arabic'],
  fa: ['Arabic'],
  he: ['Hebrew'],
  hi: ['Devanagari'],
  th: ['Thai'],
}

/** The scripts the check knows by name (a letter in none of them is reported as "Other"). */
const KNOWN_SCRIPTS = ['Latin', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Cyrillic', 'Greek', 'Arabic', 'Hebrew', 'Devanagari', 'Thai'] as const

const SCRIPT_RE: Record<string, RegExp> = Object.fromEntries(KNOWN_SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')]))
const LETTER = /\p{L}/u

function baseLanguage(code: string): string {
  const base = code.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  if (!/^[a-z]{2,3}$/.test(base)) throw new Error(`"${code}" is not a language code (expected e.g. "en", "de", "pt-BR")`)
  return base
}

/** The language's English name ("German" for "de"), from the platform's language data. */
export function languageName(code: string): string {
  const base = baseLanguage(code)
  const name = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(base)
  if (!name) throw new Error(`"${code}" is not a language this server knows the name of`)
  return name
}

/** The sentence every summary prompt ends with. */
export function outputLanguageInstruction(code: string): string {
  const name = languageName(code)
  return `Write the whole text in ${name} only. Every word is ${name}; never switch to another language or writing system, not even for single words (names and quoted terms stay as the source writes them).`
}

function scriptOf(ch: string): string {
  for (const s of KNOWN_SCRIPTS) if (SCRIPT_RE[s]!.test(ch)) return s
  return 'Other'
}

export class OutputScriptError extends Error {
  constructor(
    readonly what: string,
    readonly language: string,
    readonly scripts: string[],
    readonly sample: string,
  ) {
    super(
      `The ${what} came back with letters in ${scripts.join(', ')}, but it must be written in ${languageName(language)} (${language}): "${sample}". It was not stored.`,
    )
    this.name = 'OutputScriptError'
  }
}

/** Returns `text` when every letter is in the language's scripts (or in the source); else throws OutputScriptError. */
export function assertOutputScript(text: string, opts: { language: string; what: string; source?: string }): string {
  const allowed = new Set(LANGUAGE_SCRIPTS[baseLanguage(opts.language)] ?? ['Latin'])
  const fromSource = new Set(opts.source ? [...opts.source] : [])
  const bad = new Set<string>()
  let firstBad = -1
  const chars = [...text]
  chars.forEach((ch, i) => {
    if (!LETTER.test(ch) || fromSource.has(ch)) return
    const script = scriptOf(ch)
    if (allowed.has(script)) return
    bad.add(script)
    if (firstBad < 0) firstBad = i
  })
  if (bad.size === 0) return text
  const sample = chars.slice(Math.max(0, firstBad - 20), firstBad + 20).join('')
  throw new OutputScriptError(opts.what, opts.language, [...bad], sample)
}
