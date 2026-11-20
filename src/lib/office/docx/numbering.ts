import { parseParagraphProps, parseRunProps, type ParagraphProps, type RunProps, type ThemeFonts } from './properties'
import { intOr, onOff, wa, wc, wcs } from './xml'

/**
 * numbering.xml (ECMA-376 Part 1 §17.9): abstract numbering definitions,
 * numbering instances with level overrides, and the list counters that turn
 * a paragraph's w:numPr into its label ("1.", "iv)", "•").
 */

export type NumberingLevel = {
  ilvl: number
  start: number
  /** ST_NumberFormat (decimal, lowerRoman, upperLetter, bullet, none, …). */
  format: string
  /** w:lvlText: "%1.%2." placeholders, or the bullet character. */
  text: string
  align: 'start' | 'center' | 'end'
  suffix: 'tab' | 'space' | 'nothing'
  isLegal: boolean
  /** w:lvlRestart: restart after this (1-based) level is used; 0 never; null = after any higher level. */
  restart: number | null
  pPr: ParagraphProps
  rPr: RunProps
  source: Element
}

export type AbstractNum = { id: string; levels: Map<number, NumberingLevel>; numStyleLink: string | null; source: Element }
export type NumInstance = {
  id: string
  abstractId: string
  overrides: Map<number, { start?: number; level?: NumberingLevel }>
  source: Element
}

export type Numbering = {
  abstracts: Map<string, AbstractNum>
  nums: Map<string, NumInstance>
  /** The level definition a paragraph uses (overrides and w:numStyleLink resolved), or null. */
  level(numId: string, ilvl: number): NumberingLevel | null
  /** The abstract definition a num uses, after following w:numStyleLink. */
  abstractOf(numId: string): AbstractNum | null
}

function parseLevel(el: Element, theme: ThemeFonts): NumberingLevel {
  const jc = wa(wc(el, 'lvlJc'), 'val')
  const suff = wa(wc(el, 'suff'), 'val')
  return {
    ilvl: intOr(wa(el, 'ilvl')) ?? 0,
    start: intOr(wa(wc(el, 'start'), 'val')) ?? 0,
    format: wa(wc(el, 'numFmt'), 'val') ?? 'decimal',
    text: wa(wc(el, 'lvlText'), 'val') ?? '',
    align: jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'end' : 'start',
    suffix: suff === 'space' ? 'space' : suff === 'nothing' ? 'nothing' : 'tab',
    isLegal: onOff(wc(el, 'isLgl')) ?? false,
    restart: intOr(wa(wc(el, 'lvlRestart'), 'val')),
    pPr: parseParagraphProps(wc(el, 'pPr'), theme),
    rPr: parseRunProps(wc(el, 'rPr'), theme),
    source: el,
  }
}

/**
 * @param styleNumId the w:numId a numbering style (w:numStyleLink target) carries in its w:pPr/w:numPr.
 */
export function parseNumbering(doc: XMLDocument | null, theme: ThemeFonts, styleNumId: (styleId: string) => string | null): Numbering {
  const abstracts = new Map<string, AbstractNum>()
  const nums = new Map<string, NumInstance>()
  const root = doc?.documentElement ?? null
  if (root) {
    for (const el of wcs(root, 'abstractNum')) {
      const id = wa(el, 'abstractNumId')
      if (id === null) continue
      const levels = new Map<number, NumberingLevel>()
      for (const l of wcs(el, 'lvl')) {
        const lvl = parseLevel(l, theme)
        levels.set(lvl.ilvl, lvl)
      }
      abstracts.set(id, { id, levels, numStyleLink: wa(wc(el, 'numStyleLink'), 'val'), source: el })
    }
    for (const el of wcs(root, 'num')) {
      const id = wa(el, 'numId')
      const abstractId = wa(wc(el, 'abstractNumId'), 'val')
      if (id === null || abstractId === null) continue
      const overrides: NumInstance['overrides'] = new Map()
      for (const o of wcs(el, 'lvlOverride')) {
        const ilvl = intOr(wa(o, 'ilvl')) ?? 0
        const entry: { start?: number; level?: NumberingLevel } = {}
        const start = intOr(wa(wc(o, 'startOverride'), 'val'))
        if (start !== null) entry.start = start
        const lvl = wc(o, 'lvl')
        if (lvl) entry.level = { ...parseLevel(lvl, theme), ilvl }
        overrides.set(ilvl, entry)
      }
      nums.set(id, { id, abstractId, overrides, source: el })
    }
  }

  function abstractOf(numId: string): AbstractNum | null {
    const seen = new Set<string>()
    let num = nums.get(numId)
    while (num) {
      const a = abstracts.get(num.abstractId)
      if (!a) return null
      if (!a.numStyleLink) return a
      // A list style: its definition lives where the style's own numId points (§17.9.21).
      const next = styleNumId(a.numStyleLink)
      if (!next || seen.has(next)) return a
      seen.add(next)
      num = nums.get(next)
    }
    return null
  }

  return {
    abstracts,
    nums,
    abstractOf,
    level(numId, ilvl) {
      const num = nums.get(numId)
      if (!num) return null
      const o = num.overrides.get(ilvl)
      if (o?.level) return o.level
      return abstractOf(numId)?.levels.get(ilvl) ?? null
    },
  }
}

// ---------------------------------------------------------------- formats

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function roman(n: number): string {
  if (n <= 0) return String(n)
  let out = ''
  let rest = n
  for (const [v, s] of ROMAN) {
    while (rest >= v) {
      out += s
      rest -= v
    }
  }
  return out
}

/** Word's letter numbering repeats the letter: 26 → z, 27 → aa, 28 → bb. */
function letter(n: number): string {
  if (n <= 0) return String(n)
  const ch = String.fromCharCode(97 + ((n - 1) % 26))
  return ch.repeat(Math.floor((n - 1) / 26) + 1)
}

function ordinalSuffix(n: number): string {
  const t = n % 100
  if (t >= 11 && t <= 13) return 'th'
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
}

const CJK_DIGITS = '〇一二三四五六七八九'

function cjkCounting(n: number): string {
  if (n <= 0 || n >= 100000) return String(n)
  const units = ['', '十', '百', '千', '万']
  const digits = String(n).split('').map(Number)
  let out = ''
  digits.forEach((d, i) => {
    const place = digits.length - 1 - i
    if (d === 0) {
      if (!out.endsWith('〇') && place > 0 && digits.slice(i + 1).some((x) => x !== 0)) out += '〇'
      return
    }
    // 十 alone for 10–19 at the head ("十一", not "一十一").
    if (!(d === 1 && place === 1 && i === 0)) out += CJK_DIGITS[d]
    out += units[place]
  })
  return out
}

/** Formats a counter value; `supported` is false when the format is not one we implement (shown as decimal). */
export function formatNumber(n: number, format: string): { text: string; supported: boolean } {
  switch (format) {
    case 'decimal':
      return { text: String(n), supported: true }
    case 'decimalZero':
      return { text: n < 10 && n >= 0 ? `0${n}` : String(n), supported: true }
    case 'upperRoman':
      return { text: roman(n).toUpperCase(), supported: true }
    case 'lowerRoman':
      return { text: roman(n), supported: true }
    case 'upperLetter':
      return { text: letter(n).toUpperCase(), supported: true }
    case 'lowerLetter':
      return { text: letter(n), supported: true }
    case 'ordinal':
      return { text: `${n}${ordinalSuffix(n)}`, supported: true }
    case 'none':
    case 'bullet':
      return { text: '', supported: true }
    case 'decimalEnclosedCircle':
    case 'decimalEnclosedCircleChinese':
      return n >= 1 && n <= 20 ? { text: String.fromCharCode(0x2460 + n - 1), supported: true } : { text: String(n), supported: true }
    case 'decimalFullWidth':
    case 'decimalFullWidth2':
      return { text: String(n).replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))), supported: true }
    case 'decimalHalfWidth':
      return { text: String(n), supported: true }
    case 'ideographDigital':
    case 'japaneseDigitalTenThousand':
      return { text: String(n).replace(/\d/g, (d) => CJK_DIGITS[Number(d)]!), supported: true }
    case 'chineseCounting':
    case 'chineseCountingThousand':
    case 'japaneseCounting':
    case 'taiwaneseCounting':
    case 'taiwaneseCountingThousand':
    case 'koreanCounting':
      return { text: cjkCounting(n), supported: true }
    default:
      return { text: String(n), supported: false }
  }
}

// ---------------------------------------------------------------- counters

export type ListLabel = {
  numId: string
  ilvl: number
  level: NumberingLevel
  /** The label text ("1.2.", "•"); empty for numFmt none. */
  text: string
  /** This level's own counter value. */
  value: number
  /** Formats in the label we don't implement (shown as decimal). */
  unsupported: string[]
}

/**
 * List counters in document order. Counters belong to the abstract
 * definition, so separate w:num instances of one list continue it; a num's
 * w:startOverride restarts the level when that num is first used.
 */
export class ListCounter {
  private counters = new Map<string, (number | null)[]>()
  private used = new Set<string>()

  constructor(private readonly numbering: Numbering) {}

  next(numId: string, ilvl: number): ListLabel | null {
    if (numId === '0' || numId === '') return null
    const num = this.numbering.nums.get(numId)
    const abstract = this.numbering.abstractOf(numId)
    const level = this.numbering.level(numId, ilvl)
    if (!num || !abstract || !level) return null
    const key = abstract.id
    const c = this.counters.get(key) ?? Array<number | null>(9).fill(null)
    this.counters.set(key, c)
    const startOf = (l: number) => num.overrides.get(l)?.start ?? this.numbering.level(numId, l)?.start ?? 0
    if (!this.used.has(numId)) {
      this.used.add(numId)
      for (const [l, o] of num.overrides) if (o.start !== undefined) c[l] = null
    }
    c[ilvl] = c[ilvl] === null || c[ilvl] === undefined ? startOf(ilvl) : c[ilvl]! + 1
    for (let k = ilvl + 1; k < 9; k++) {
      const restart = this.numbering.level(numId, k)?.restart ?? null
      // lvlRestart n (1-based): restart when a level up to n is used; 0 never; absent: any higher level.
      if (restart === 0) continue
      if (restart === null || ilvl < restart) c[k] = null
    }
    const unsupported: string[] = []
    let text = ''
    if (level.format === 'bullet') text = level.text
    else if (level.format !== 'none') {
      text = level.text.replace(/%([1-9])/g, (_, d: string) => {
        const l = Number(d) - 1
        const value = c[l] ?? startOf(l)
        const fmt = level.isLegal ? 'decimal' : l === ilvl ? level.format : (this.numbering.level(numId, l)?.format ?? 'decimal')
        const f = formatNumber(value, fmt)
        if (!f.supported) unsupported.push(fmt)
        return f.text
      })
    }
    return { numId, ilvl, level, text, value: c[ilvl]!, unsupported }
  }
}
