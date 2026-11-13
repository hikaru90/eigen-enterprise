import type { Channel, ChannelType, ImportCandidate } from './types'

/**
 * Reading contacts from a file (Contribute b8a87a25, import) — pure, runs in
 * the browser; nothing here saves. The service checks every candidate again
 * (limits, tags, duplicates by email) for the preview and on import.
 *
 * - vCard (.vcf, RFC 6350 / 2426, plus 2.1's quoted-printable): a structured
 *   format, so each property says what its value is (FN/N → name, ORG, TITLE,
 *   EMAIL, TEL, URL → website, X-SOCIALPROFILE;TYPE=linkedin → LinkedIn,
 *   IMPP → other, NOTE → why they matter, CATEGORIES → tags). Photos, birthdays
 *   and addresses are not part of a contact here and are left out.
 * - CSV: RFC 4180 rows with the separator the person picks. What a column
 *   means is the person's choice (AGENTS.md: no guessing meaning from header
 *   names) — `csvCandidates` applies their mapping, `checkMapping` says what
 *   is missing or doubled.
 */

// ── vCard ─────────────────────────────────────────────────────────────────────

type VcardLine = { name: string; params: Map<string, string[]>; value: string }

/** Unfolds continuation lines (a leading space or tab), and 2.1 quoted-printable soft breaks (`=` at the end). */
function unfold(text: string): string[] {
  const raw = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  const out: string[] = []
  for (const line of raw) {
    const prev = out.length - 1
    if (prev >= 0 && (line.startsWith(' ') || line.startsWith('\t'))) {
      out[prev] += line.slice(1)
    } else if (prev >= 0 && /ENCODING=QUOTED-PRINTABLE/i.test(out[prev]!.split(':')[0]!) && out[prev]!.endsWith('=')) {
      out[prev] = out[prev]!.slice(0, -1) + line
    } else {
      out.push(line)
    }
  }
  return out.filter((l) => l.trim() !== '')
}

/** Splits `NAME;PARAM=a,b:value` at the first colon outside a quoted parameter value. */
function parseLine(line: string): VcardLine | null {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const [head, ...paramParts] = line.slice(0, colon).split(';')
  // `item1.EMAIL` — the group prefix only ties properties together.
  const name = head!.slice(head!.lastIndexOf('.') + 1).toUpperCase()
  const params = new Map<string, string[]>()
  for (const p of paramParts) {
    const eq = p.indexOf('=')
    // vCard 2.1 allows bare types: `TEL;CELL:…`.
    const key = (eq < 0 ? 'TYPE' : p.slice(0, eq)).toUpperCase()
    const values = (eq < 0 ? p : p.slice(eq + 1)).split(',').map((v) => v.replace(/^"|"$/g, '').toLowerCase())
    params.set(key, [...(params.get(key) ?? []), ...values])
  }
  let value = line.slice(colon + 1)
  if (params.get('ENCODING')?.includes('quoted-printable')) value = decodeQuotedPrintable(value, params.get('CHARSET')?.[0] ?? 'utf-8')
  return { name, params, value }
}

function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    const hex = value.slice(i + 1, i + 3)
    if (value[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      i += 2
    } else {
      bytes.push(...new TextEncoder().encode(value[i]!))
    }
  }
  return new TextDecoder(charset, { fatal: true }).decode(new Uint8Array(bytes))
}

/** A text value's escapes (`\n`, `\,`, `\;`, `\\`). */
function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

/** A structured value's components (`;`-separated, escapes kept apart). */
function components(value: string, sep: ';' | ','): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (ch === '\\' && i + 1 < value.length) {
      cur += ch + value[i + 1]
      i++
    } else if (ch === sep) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((c) => unescapeText(c).trim())
}

const text = (v: string) => {
  const t = unescapeText(v).trim()
  return t === '' ? null : t
}

function cardToCandidate(lines: VcardLine[]): ImportCandidate {
  const first = (prop: string) => lines.find((l) => l.name === prop)
  const fn = first('FN')
  let name = fn ? (text(fn.value) ?? '') : ''
  const n = first('N')
  if (name === '' && n) {
    const [family = '', given = '', additional = '', prefix = '', suffix = ''] = components(n.value, ';')
    name = [prefix, given, additional, family, suffix].filter((p) => p !== '').join(' ')
  }
  const org = first('ORG')
  const title = first('TITLE') ?? first('ROLE')
  const channels: Channel[] = []
  const add = (type: ChannelType, value: string) => {
    const v = text(value)
    if (v !== null) channels.push({ type, value: v })
  }
  for (const l of lines) {
    if (l.name === 'EMAIL') add('email', l.value)
    else if (l.name === 'TEL') add('phone', l.value.replace(/^tel:/i, ''))
    else if (l.name === 'URL') add('website', l.value)
    else if (l.name === 'X-SOCIALPROFILE') add(l.params.get('TYPE')?.includes('linkedin') ? 'linkedin' : 'other', l.value)
    else if (l.name === 'IMPP') add('other', l.value)
  }
  const notes = lines.filter((l) => l.name === 'NOTE').map((l) => text(l.value)).filter((v): v is string => v !== null)
  const tags = lines.filter((l) => l.name === 'CATEGORIES').flatMap((l) => components(l.value, ',')).filter((t) => t !== '')
  return {
    name,
    organisation: org ? components(org.value, ';').filter((c) => c !== '').join(', ') || null : null,
    title: title ? text(title.value) : null,
    channels,
    metHow: null,
    whyRelevant: notes.length > 0 ? notes.join('\n') : null,
    tags,
  }
}

/** Every card in a .vcf file, in order. A file without one (or a card left open) fails loud. */
export function parseVcards(file: string): ImportCandidate[] {
  const cards: ImportCandidate[] = []
  let current: VcardLine[] | null = null
  for (const raw of unfold(file)) {
    const line = parseLine(raw)
    if (!line) continue
    if (line.name === 'BEGIN' && line.value.trim().toUpperCase() === 'VCARD') {
      if (current) throw new Error('A card starts before the previous one ends (END:VCARD missing).')
      current = []
    } else if (line.name === 'END' && line.value.trim().toUpperCase() === 'VCARD') {
      if (!current) throw new Error('END:VCARD without BEGIN:VCARD.')
      cards.push(cardToCandidate(current))
      current = null
    } else if (current) current.push(line)
  }
  if (current) throw new Error('The last card is not closed (END:VCARD missing).')
  if (cards.length === 0) throw new Error('This file holds no vCard (no BEGIN:VCARD … END:VCARD).')
  return cards
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export const CSV_SEPARATORS = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
] as const
export type CsvSeparator = (typeof CSV_SEPARATORS)[number]['value']

/** RFC 4180 rows (quotes, doubled quotes, line breaks inside quotes); empty lines are skipped. */
export function parseCsv(file: string, separator: CsvSeparator): string[][] {
  const s = file.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const endRow = () => {
    row.push(field)
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
    field = ''
  }
  while (i < s.length) {
    const ch = s[i]!
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"'
        i += 2
        continue
      }
      if (ch === '"') quoted = false
      else field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === separator) {
      row.push(field)
      field = ''
    } else if (ch === '\r' || ch === '\n') {
      endRow()
      if (ch === '\r' && s[i + 1] === '\n') i++
    } else field += ch
    i++
  }
  if (quoted) throw new Error('A quote (") is opened and never closed.')
  if (field !== '' || row.length > 0) endRow()
  return rows
}

/** What a CSV column can be. "ignore" leaves it out. */
export const CSV_TARGETS = [
  { value: 'ignore', label: 'Don’t import' },
  { value: 'name', label: 'Full name' },
  { value: 'firstName', label: 'First name' },
  { value: 'lastName', label: 'Last name' },
  { value: 'organisation', label: 'Organisation' },
  { value: 'title', label: 'Role or title' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'website', label: 'Website' },
  { value: 'other', label: 'Other way to reach them' },
  { value: 'metHow', label: 'Where or how you met' },
  { value: 'whyRelevant', label: 'Why they matter' },
  { value: 'tags', label: 'Tags (separated by , or ;)' },
] as const
export type CsvTarget = (typeof CSV_TARGETS)[number]['value']

/** Targets a single column can be (the rest — channels, tags — may come from several). */
const SINGLE: readonly CsvTarget[] = ['name', 'firstName', 'lastName', 'organisation', 'title', 'metHow', 'whyRelevant']
const CHANNEL_TARGETS: readonly CsvTarget[] = ['email', 'phone', 'linkedin', 'website', 'other']
const labelOf = (t: CsvTarget) => CSV_TARGETS.find((x) => x.value === t)!.label

/** What is wrong with a mapping, in plain words (none = it can be read). */
export function checkMapping(mapping: readonly CsvTarget[]): string[] {
  const problems: string[] = []
  if (!mapping.some((t) => t === 'name' || t === 'firstName' || t === 'lastName')) {
    problems.push('Pick the column with the name (or the first and last name).')
  }
  for (const t of SINGLE) {
    if (mapping.filter((m) => m === t).length > 1) problems.push(`Only one column can be ${labelOf(t)}.`)
  }
  return problems
}

/** The number of columns: the widest row. */
export const columnCount = (rows: readonly string[][]) => rows.reduce((n, r) => Math.max(n, r.length), 0)

/** The rows as contacts, as the person mapped them. A mapping that doesn't fit fails loud. */
export function csvCandidates(rows: readonly string[][], mapping: readonly CsvTarget[], opts: { headerRow: boolean }): ImportCandidate[] {
  const columns = columnCount(rows)
  if (mapping.length !== columns) throw new Error(`The file has ${columns} columns; say for each one what it holds.`)
  const problems = checkMapping(mapping)
  if (problems.length > 0) throw new Error(problems.join(' '))
  const body = opts.headerRow ? rows.slice(1) : rows
  return body.map((row) => {
    const cell = (i: number) => (row[i] ?? '').trim()
    const one = (t: CsvTarget) => {
      const i = mapping.indexOf(t)
      return i < 0 || cell(i) === '' ? null : cell(i)
    }
    const name = one('name') ?? [one('firstName'), one('lastName')].filter((p) => p !== null).join(' ')
    const channels: Channel[] = []
    const tags: string[] = []
    mapping.forEach((t, i) => {
      if (cell(i) === '') return
      if (CHANNEL_TARGETS.includes(t)) channels.push({ type: t as ChannelType, value: cell(i) })
      else if (t === 'tags') tags.push(...cell(i).split(/[,;]/).map((x) => x.trim()).filter((x) => x !== ''))
    })
    return {
      name,
      organisation: one('organisation'),
      title: one('title'),
      channels,
      metHow: one('metHow'),
      whyRelevant: one('whyRelevant'),
      tags,
    }
  })
}
