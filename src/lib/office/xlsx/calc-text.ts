import { asMatrix, err, isMatrix, toNumber, toText, truthy, Unsupported, type Matrix } from './calc-values'
import { colName, MAX_COLS, MAX_ROWS } from './ref'
import { quoteSheet } from './shift'
import { isErrorValue, type CellValue, type ErrorValue } from './workbook'

/**
 * Text functions of Microsoft 365 as Microsoft's function reference
 * documents them: TEXTBEFORE, TEXTAFTER, REGEXTEST, REGEXEXTRACT,
 * REGEXREPLACE, ARRAYTOTEXT, VALUETOTEXT, ENCODEURL, ADDRESS.
 *
 * Excel's regular expressions are PCRE2; JavaScript's RegExp agrees with it
 * on the common syntax (classes, quantifiers, groups, alternation, anchors,
 * \d \w \s \b, back references, lookaround). A pattern using what the two
 * read differently (possessive quantifiers, atomic groups, inline options,
 * \A \Z \h \R \K \Q…\E, POSIX classes, Unicode properties …), a
 * case-insensitive match over non-ASCII text, astral characters, empty
 * matches in a global search, or a `$` before a final line break is refused
 * (`Unsupported`), never approximated.
 */

/** An argument: a value, an array (a range parameter), or undefined when it was left out. */
export type TArg = CellValue | Matrix | undefined
export type TextFn = (args: TArg[]) => CellValue | Matrix

class Fail {
  constructor(readonly error: ErrorValue) {}
}
const fail = (code: string): never => {
  throw new Fail(err(code))
}

function scalar(a: TArg, fn: string): CellValue | undefined {
  if (a === undefined || !isMatrix(a)) return a
  if (a.length === 1 && a[0]!.length === 1) return a[0]![0]!
  throw new Unsupported(`${fn} with an array where one value goes`)
}

function text(a: TArg, fn: string): string {
  const v = scalar(a, fn)
  if (v === undefined) return fail('#VALUE!')
  if (isErrorValue(v)) throw new Fail(v)
  const t = toText(v)
  if (isErrorValue(t)) throw new Fail(t)
  return t
}

function int(a: TArg, fn: string, def: number): number {
  const v = scalar(a, fn)
  if (v === undefined) return def
  if (isErrorValue(v)) throw new Fail(v)
  const n = toNumber(v)
  if (isErrorValue(n)) throw new Fail(n)
  return Math.trunc(n)
}

function flag(a: TArg, fn: string, def: boolean): boolean {
  const v = scalar(a, fn)
  if (v === undefined) return def
  if (isErrorValue(v)) throw new Fail(v)
  if (typeof v === 'number') {
    if (v !== 0 && v !== 1) fail('#VALUE!')
    return v === 1
  }
  const t = truthy(v)
  if (isErrorValue(t)) throw new Fail(t)
  return t
}

function guard(f: () => CellValue | Matrix): CellValue | Matrix {
  try {
    return f()
  } catch (e) {
    if (e instanceof Fail) return e.error
    throw e
  }
}

/** Lower case for case-insensitive matching; a character whose lower case changes the length is refused. */
function lower(s: string, fn: string): string {
  const l = s.toLowerCase()
  if (l.length !== s.length)
    throw new Unsupported(`${fn} ignoring case of “${s}” (its case mapping changes its length)`)
  return l
}

// ---------------------------------------------------------------------------
// TEXTBEFORE, TEXTAFTER

type Hit = { start: number; end: number }

function delimiterHits(s: string, delims: string[], fromEnd: boolean): Hit[] {
  const out: Hit[] = []
  if (!fromEnd) {
    for (let i = 0; i < s.length; ) {
      let len = -1
      for (const d of delims) if (d !== '' && s.startsWith(d, i) && d.length > len) len = d.length
      if (len > 0) {
        out.push({ start: i, end: i + len })
        i += len
      } else i++
    }
    return out
  }
  for (let i = s.length; i > 0; ) {
    let len = -1
    for (const d of delims)
      if (d !== '' && d.length <= i && s.slice(i - d.length, i) === d && d.length > len)
        len = d.length
    if (len > 0) {
      out.push({ start: i - len, end: i })
      i -= len
    } else i--
  }
  return out
}

function textSide(args: TArg[], before: boolean): CellValue | Matrix {
  const fn = before ? 'TEXTBEFORE' : 'TEXTAFTER'
  return guard(() => {
    const s = text(args[0], fn)
    if (args[1] === undefined) fail('#VALUE!')
    const delims = asMatrix(args[1]!)
      .flat()
      .map((v) => {
        if (isErrorValue(v)) throw new Fail(v)
        const t = toText(v)
        if (isErrorValue(t)) throw new Fail(t)
        return t
      })
    const n = int(args[2], fn, 1)
    const mode = int(args[3], fn, 0)
    if (mode !== 0 && mode !== 1) fail('#VALUE!')
    const matchEnd = flag(args[4], fn, false)
    if (s === '') return ''
    if (n === 0 || Math.abs(n) > s.length) fail('#VALUE!')
    const notFound = (): CellValue => {
      if (args[5] === undefined) return err('#N/A')
      const v = scalar(args[5], fn)
      return v === undefined ? err('#N/A') : v
    }
    if (delims.includes('')) {
      // An empty delimiter matches at once (documented for the first instance from either end).
      if (Math.abs(n) !== 1)
        throw new Unsupported(`${fn} with an empty delimiter and instance ${n}`)
      return (n > 0) === before ? '' : s
    }
    const hay = mode === 1 ? lower(s, fn) : s
    const needles = mode === 1 ? delims.map((d) => lower(d, fn)) : delims
    const hits = delimiterHits(hay, needles, n < 0)
    const k = Math.abs(n)
    if (hits.length >= k) {
      const h = hits[k - 1]!
      return before ? s.slice(0, h.start) : s.slice(h.end)
    }
    // match_end: the end of the text (from the end: its start) counts as one more delimiter.
    if (matchEnd && hits.length === k - 1) {
      if (n > 0) return before ? s : ''
      return before ? '' : s
    }
    return notFound()
  })
}

// ---------------------------------------------------------------------------
// Regular expressions

/** What PCRE2 and JavaScript read differently: refused rather than guessed. */
function checkPattern(p: string, fn: string): { dollar: boolean } {
  const refuse = (what: string): never => {
    throw new Unsupported(`${fn} with ${what} in the pattern (PCRE2 and this engine differ there)`)
  }
  let inClass = false
  let dollar = false
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!
    if (ch === '\\') {
      const next = p[i + 1]
      if (next === undefined) refuse('a trailing backslash')
      if (/[AZzGKQEhHvVRXCNgopPex]/.test(next!)) refuse(`\\${next}`)
      if (/[0-9]/.test(next!) && /[0-9]/.test(p[i + 2] ?? '')) refuse('a back reference past \\9')
      if (next === '0') refuse('\\0')
      if (next === 'k' && p[i + 2] !== '<') refuse('\\k')
      i++
      continue
    }
    if (inClass) {
      if (ch === '[' && p[i + 1] === ':') refuse('a POSIX class')
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      if (p[i + 1] === '^') i++
      if (p[i + 1] === ']') i++ // a leading ] is literal
      continue
    }
    if (ch === '$') dollar = true
    if (ch === '(' && p[i + 1] === '?') {
      const rest = p.slice(i + 2)
      const ok = /^(:|=|!|<=|<!|<[A-Za-z_])/.test(rest)
      if (!ok) refuse(`the group “(?${rest.slice(0, 2)}”`)
    }
    if ((ch === '*' || ch === '+' || ch === '?' || ch === '}') && p[i + 1] === '+')
      refuse('a possessive quantifier')
  }
  return { dollar }
}

const ASTRAL = /[\uD800-\uDFFF]/

// eslint-disable-next-line no-control-regex -- the ASCII range starts at U+0000
const NON_ASCII = /[^\x00-\x7f]/

function compile(pattern: string, caseless: boolean, s: string, fn: string): RegExp {
  const { dollar } = checkPattern(pattern, fn)
  if (ASTRAL.test(pattern) || ASTRAL.test(s))
    throw new Unsupported(`${fn} over characters outside the Basic Multilingual Plane`)
  if (caseless && (NON_ASCII.test(pattern) || NON_ASCII.test(s)))
    throw new Unsupported(`${fn} ignoring case of non-ASCII text`)
  if (dollar && s.endsWith('\n')) throw new Unsupported(`${fn} with $ and text ending in a line break`)
  try {
    return new RegExp(pattern, caseless ? 'gi' : 'g')
  } catch {
    throw new Unsupported(`${fn} with the pattern “${pattern}”`)
  }
}

function caseArg(a: TArg, fn: string): boolean {
  const c = int(a, fn, 0)
  if (c !== 0 && c !== 1) fail('#VALUE!')
  return c === 1
}

function allMatches(re: RegExp, s: string, fn: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = []
  re.lastIndex = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[0] === '') throw new Unsupported(`${fn} with a pattern that matches empty text`)
    out.push(m)
  }
  return out
}

function regexTest(args: TArg[]): CellValue | Matrix {
  const fn = 'REGEXTEST'
  return guard(() => {
    const s = text(args[0], fn)
    const p = text(args[1], fn)
    const re = compile(p, caseArg(args[2], fn), s, fn)
    re.lastIndex = 0
    return re.test(s)
  })
}

function regexExtract(args: TArg[]): CellValue | Matrix {
  const fn = 'REGEXEXTRACT'
  return guard(() => {
    const s = text(args[0], fn)
    const p = text(args[1], fn)
    const mode = int(args[2], fn, 0)
    if (mode < 0 || mode > 2) fail('#VALUE!')
    const re = compile(p, caseArg(args[3], fn), s, fn)
    if (mode === 1) {
      const all = allMatches(re, s, fn)
      if (all.length === 0) return err('#N/A')
      return all.map((m) => [m[0]])
    }
    re.lastIndex = 0
    const m = re.exec(s)
    if (!m) return err('#N/A')
    if (mode === 0) return m[0]
    if (m.length < 2) throw new Unsupported(`${fn} return mode 2 with a pattern without groups`)
    const groups = m.slice(1)
    if (groups.some((g) => g === undefined))
      throw new Unsupported(`${fn} with a capturing group that did not take part in the match`)
    return [groups as string[]]
  })
}

/** PCRE2's basic substitution: $n, ${n} and $$; anything else after $ is refused. */
function substitute(replacement: string, m: RegExpExecArray, fn: string): string {
  let out = ''
  for (let i = 0; i < replacement.length; i++) {
    const ch = replacement[i]!
    if (ch !== '$') {
      out += ch
      continue
    }
    const rest = replacement.slice(i + 1)
    let digits: string
    let used: number
    const plain = /^[0-9]+/.exec(rest)
    const braced = /^\{([0-9]+)\}/.exec(rest)
    if (rest.startsWith('$')) {
      out += '$'
      i++
      continue
    }
    if (plain) {
      digits = plain[0]
      used = plain[0].length
    } else if (braced) {
      digits = braced[1]!
      used = braced[0].length
    } else throw new Unsupported(`${fn} with “$${rest.slice(0, 1)}” in the replacement`)
    const g = Number(digits)
    if (g >= m.length) throw new Unsupported(`${fn} with $${g} (the pattern has no such group)`)
    out += m[g] ?? ''
    i += used
  }
  return out
}

function regexReplace(args: TArg[]): CellValue | Matrix {
  const fn = 'REGEXREPLACE'
  return guard(() => {
    const s = text(args[0], fn)
    const p = text(args[1], fn)
    const rep = text(args[2], fn)
    const occurrence = int(args[3], fn, 0)
    const re = compile(p, caseArg(args[4], fn), s, fn)
    const all = allMatches(re, s, fn)
    let chosen: RegExpExecArray[]
    if (occurrence === 0) chosen = all
    else {
      const i = occurrence > 0 ? occurrence - 1 : all.length + occurrence
      if (i < 0 || i >= all.length)
        throw new Unsupported(`${fn} of occurrence ${occurrence} when there are ${all.length}`)
      chosen = [all[i]!]
    }
    let out = ''
    let at = 0
    for (const m of chosen) {
      out += s.slice(at, m.index) + substitute(rep, m, fn)
      at = m.index + m[0].length
    }
    return out + s.slice(at)
  })
}

// ---------------------------------------------------------------------------
// ARRAYTOTEXT, VALUETOTEXT

function asText(v: CellValue, strict: boolean, fn: string): string {
  if (v === null) throw new Unsupported(`${fn} of an empty cell`)
  if (isErrorValue(v)) return v.error
  const t = toText(v) as string
  return strict && typeof v === 'string' ? `"${t.replace(/"/g, '""')}"` : t
}

function formatArg(a: TArg, fn: string): boolean {
  const f = int(a, fn, 0)
  if (f !== 0 && f !== 1) fail('#VALUE!')
  return f === 1
}

function arrayToText(args: TArg[]): CellValue | Matrix {
  const fn = 'ARRAYTOTEXT'
  return guard(() => {
    if (args[0] === undefined) fail('#VALUE!')
    const m = asMatrix(args[0]!)
    const strict = formatArg(args[1], fn)
    if (!strict)
      return m
        .flat()
        .map((v) => asText(v, false, fn))
        .join(', ')
    return `{${m.map((r) => r.map((v) => asText(v, true, fn)).join(',')).join(';')}}`
  })
}

function valueToText(args: TArg[]): CellValue | Matrix {
  const fn = 'VALUETOTEXT'
  return guard(() => {
    const v = scalar(args[0], fn)
    if (v === undefined) fail('#VALUE!')
    const strict = formatArg(args[1], fn)
    if (v === null && !strict) return ''
    return asText(v!, strict, fn)
  })
}

// ---------------------------------------------------------------------------
// ENCODEURL, ADDRESS

function encodeUrl(args: TArg[]): CellValue | Matrix {
  const fn = 'ENCODEURL'
  return guard(() => {
    const s = text(args[0], fn)
    if (/[!'()*]/.test(s)) throw new Unsupported(`${fn} of text with ! ' ( ) or *`)
    try {
      return encodeURIComponent(s)
    } catch {
      // A lone surrogate has no UTF-8 form.
      return fail('#VALUE!')
    }
  })
}

function address(args: TArg[]): CellValue | Matrix {
  const fn = 'ADDRESS'
  return guard(() => {
    const row = int(args[0], fn, NaN)
    const col = int(args[1], fn, NaN)
    const abs = int(args[2], fn, 1)
    const a1 = flag(args[3], fn, true)
    if (!(row >= 1 && row <= MAX_ROWS) || !(col >= 1 && col <= MAX_COLS)) fail('#VALUE!')
    if (abs < 1 || abs > 4) fail('#VALUE!')
    const absRow = abs === 1 || abs === 2
    const absCol = abs === 1 || abs === 3
    const ref = a1
      ? `${absCol ? '$' : ''}${colName(col - 1)}${absRow ? '$' : ''}${row}`
      : `R${absRow ? row : `[${row}]`}C${absCol ? col : `[${col}]`}`
    const sheetV = scalar(args[4], fn)
    if (sheetV === undefined || sheetV === null) return ref
    if (isErrorValue(sheetV)) return sheetV
    const sheet = toText(sheetV) as string
    if (sheet === '') return `!${ref}`
    return `${quoteSheet(sheet)}!${ref}`
  })
}

export const TEXT_FUNCTIONS: Record<string, TextFn> = {
  TEXTBEFORE: (a) => textSide(a, true),
  TEXTAFTER: (a) => textSide(a, false),
  REGEXTEST: regexTest,
  REGEXEXTRACT: regexExtract,
  REGEXREPLACE: regexReplace,
  ARRAYTOTEXT: arrayToText,
  VALUETOTEXT: valueToText,
  ENCODEURL: encodeUrl,
  ADDRESS: address,
}
