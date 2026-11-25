import { format as formatNumber, formatColor, isDateFormat, parseValue } from 'numfmt'
import { isErrorValue, type CellValue } from './workbook'

/**
 * Cell values as text, the way Excel shows them: through the cell's number
 * format (ECMA-376 Part 1 §18.8.31, rendered by numfmt, MIT) in the
 * person's locale; and what a person types, read the way Excel reads it
 * ("12,5" in German, "50%", "2024-01-05", "TRUE"), with the format the
 * input implies.
 */

export type SheetLocale = 'en' | 'de'

/** Built-in format 14 is "the locale's short date" (§18.8.30). */
const SHORT_DATE: Record<SheetLocale, string> = { en: 'm/d/yyyy', de: 'dd.mm.yyyy' }
const BOOL: Record<SheetLocale, [string, string]> = { en: ['TRUE', 'FALSE'], de: ['WAHR', 'FALSCH'] }

export function formatCode(numFmtId: number, code: string, locale: SheetLocale): string {
  return numFmtId === 14 ? SHORT_DATE[locale] : code
}

/** The text a cell shows, and the colour its format asks for (e.g. `[Red]` for negatives). */
export function displayValue(
  value: CellValue,
  code: string,
  locale: SheetLocale,
  opts: { date1904?: boolean } = {},
): { text: string; color: string | null; unreadFormat?: true } {
  if (value === null) return { text: '', color: null }
  if (isErrorValue(value)) return { text: value.error, color: null }
  if (typeof value === 'boolean') return { text: BOOL[locale][value ? 0 : 1], color: null }
  const serial = typeof value === 'number' && opts.date1904 && isDateFormat(code) ? value + 1462 : value
  try {
    const text = formatNumber(code, serial, { locale, throws: true, nbsp: false, leap1900: true })
    const c = formatColor(code, serial, { throws: false })
    return { text, color: typeof c === 'string' ? c : null }
  } catch {
    // A format code numfmt can't read: the plain value, flagged so the grid says so.
    return { text: formatNumber('General', serial, { locale }), color: null, unreadFormat: true }
  }
}

/** What a typed entry means: a formula (leading "="), a literal text ("'" first), else a number/date/boolean when it reads as one, else text. */
export type ParsedInput =
  | { kind: 'formula'; formula: string }
  | { kind: 'value'; value: number | string | boolean | null; format?: string }

/** Formats the input implies, by numfmt's built-in id (`formatId`): dates, times, percent, currency. */
export function parseInput(text: string, locale: SheetLocale): ParsedInput {
  if (text === '') return { kind: 'value', value: null }
  if (text.startsWith('=') && text.length > 1) return { kind: 'formula', formula: text.slice(1) }
  if (text.startsWith("'")) return { kind: 'value', value: text.slice(1) }
  const [t, f] = BOOL[locale]
  const upper = text.trim().toUpperCase()
  if (upper === t || upper === 'TRUE') return { kind: 'value', value: true }
  if (upper === f || upper === 'FALSE') return { kind: 'value', value: false }
  const parsed = parseValue(text.trim(), { locale })
  if (parsed && typeof parsed.value === 'number') {
    const id = parsed.formatId
    return id === undefined ? { kind: 'value', value: parsed.value } : { kind: 'value', value: parsed.value, format: id === 14 ? 'mm-dd-yy' : builtinCode(id) }
  }
  return { kind: 'value', value: text }
}

/** numfmt's ids are the built-in ids of §18.8.30. */
function builtinCode(id: number): string {
  const codes: Record<number, string> = {
    1: '0',
    2: '0.00',
    3: '#,##0',
    4: '#,##0.00',
    9: '0%',
    10: '0.00%',
    11: '0.00E+00',
    12: '# ?/?',
    13: '# ??/??',
    15: 'd-mmm-yy',
    16: 'd-mmm',
    17: 'mmm-yy',
    18: 'h:mm AM/PM',
    19: 'h:mm:ss AM/PM',
    20: 'h:mm',
    21: 'h:mm:ss',
    22: 'm/d/yy h:mm',
    45: 'mm:ss',
    46: '[h]:mm:ss',
    47: 'mmss.0',
    48: '##0.0E+0',
  }
  return codes[id] ?? 'General'
}

/** The text of a cell's content for editing: the formula with "=", or the value in a form `parseInput` reads back. */
export function editText(value: CellValue, formula: string | null, code: string, locale: SheetLocale, date1904 = false): string {
  if (formula !== null) return `=${formula}`
  if (value === null) return ''
  if (isErrorValue(value)) return value.error
  if (typeof value === 'boolean') return BOOL[locale][value ? 0 : 1]
  if (typeof value === 'string') {
    // Text that would read back as a number, date, boolean or formula keeps its leading apostrophe.
    const back = parseInput(value, locale)
    return back.kind === 'value' && back.value === value ? value : `'${value}`
  }
  if (isDateFormat(code)) return displayValue(value, code, locale, { date1904 }).text
  return formatNumber('General', value, { locale })
}

/** The formats offered in the toolbar (code written to the file; label from the UI strings). */
export const FORMAT_CHOICES = [
  { id: 'general', code: 'General' },
  { id: 'number', code: '#,##0.00' },
  { id: 'integer', code: '#,##0' },
  { id: 'percent', code: '0.00%' },
  { id: 'currency_eur', code: '#,##0.00 [$€-407]' },
  { id: 'currency_usd', code: '[$$-409]#,##0.00' },
  { id: 'date', code: 'mm-dd-yy' },
  { id: 'date_iso', code: 'yyyy-mm-dd' },
  { id: 'time', code: 'h:mm' },
  { id: 'datetime', code: 'yyyy-mm-dd h:mm' },
  { id: 'text', code: '@' },
] as const

export type FormatChoiceId = (typeof FORMAT_CHOICES)[number]['id']
