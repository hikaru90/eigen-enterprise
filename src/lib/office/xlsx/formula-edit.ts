import { parseA1Ref, stringifyA1Ref, tokenize } from '@borgar/fx/xlsx'
import { functionSig, functionsStartingWith, type FunctionSig } from './function-catalog'
import { MAX_COLS, MAX_ROWS, type Range } from './ref'
import { quoteSheet } from './shift'

/**
 * Formula-bar editing ergonomics:
 * - Function autocomplete (`autocompleteContext`, `acceptAutocomplete`)
 * - Active call & argument-hint index (`activeFunctionCall`)
 * - Coloured reference ranges for syntax highlighting + grid overlays (`formulaReferences`)
 * - Point-to-select cell/range reference insertion (`canInsertReferenceAt`, `insertReferenceAt`)
 * - F4 cycling of `$` absolute/relative locks (`cycleAbsoluteAt`)
 */

export const REF_COLORS = [
  '#2563eb',
  '#dc2626',
  '#7c3aed',
  '#059669',
  '#d97706',
  '#db2777',
] as const

type FxToken = { type: string; value: string }

type SpanToken = FxToken & { start: number; end: number }

function spanTokens(body: string): SpanToken[] {
  const toks = tokenize(body, { mergeRefs: true }) as FxToken[]
  const out: SpanToken[] = []
  let pos = 0
  for (const t of toks) {
    const start = pos
    const end = pos + t.value.length
    out.push({ ...t, start, end })
    pos = end
  }
  return out
}

export type AutocompleteContext = {
  from: number
  to: number
  prefix: string
  matches: FunctionSig[]
}

/**
 * Finds the function-name prefix right before `cursor` (with leading `=`):
 * e.g. `=SUM(VLO` -> `{ from: 5, to: 8, prefix: 'VLO', matches: [...] }`.
 */
export function autocompleteContext(
  text: string,
  cursor: number,
  limit = 12,
): AutocompleteContext | null {
  if (!text.startsWith('=')) return null
  const clamped = Math.max(0, Math.min(cursor, text.length))
  if (clamped <= 1) return null
  const body = text.slice(1)
  const rel = clamped - 1
  const toks = spanTokens(body)
  // Do not autocomplete inside strings, errors, or after `!` (sheet name) or cell refs followed by digits
  const hit = toks.find((t) => rel > t.start && rel <= t.end)
  if (!hit) return null
  if (hit.type === 'string' || hit.type === 'error') return null
  // Extract trailing identifier before `rel`
  const before = body.slice(0, rel)
  const m = /(?:^|[=+\-*/^&<>,;(\s{])([A-Za-z_][A-Za-z0-9_.]*)$/.exec(before)
  if (!m) return null
  const prefix = m[1]!
  // Exclude valid cell references like A1 or AB12
  if (/^[A-Za-z]{1,3}\d+$/.test(prefix)) return null
  const matches = functionsStartingWith(prefix, limit)
  if (matches.length === 0) return null
  return {
    from: clamped - prefix.length,
    to: clamped,
    prefix,
    matches,
  }
}

export function acceptAutocomplete(
  text: string,
  ctx: AutocompleteContext,
  name: string,
): { text: string; cursor: number } {
  const next = `${text.slice(0, ctx.from)}${name}(${text.slice(ctx.to)}`
  return { text: next, cursor: ctx.from + name.length + 1 }
}

export type ActiveFunctionCall = {
  sig: FunctionSig
  /** 0-based index of the argument currently at `cursor`. */
  argIndex: number
  /** The index inside `sig.args` to highlight (maps repeating tails back to their pattern). */
  highlightIndex: number
}

/** Returns the innermost function call enclosing `cursor` and which argument is active. */
export function activeFunctionCall(text: string, cursor: number): ActiveFunctionCall | null {
  if (!text.startsWith('=')) return null
  const clamped = Math.max(1, Math.min(cursor, text.length))
  const body = text.slice(1, clamped)
  const toks = spanTokens(body)
  const stack: Array<{ name: string; argIndex: number; braceDepth: number }> = []

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.type === 'func') {
      const next = toks[i + 1]
      if (next?.type === 'operator' && next.value === '(') {
        stack.push({ name: t.value, argIndex: 0, braceDepth: 0 })
        i++
      }
      continue
    }
    if (t.type !== 'operator') continue
    if (t.value === '(') {
      stack.push({ name: '', argIndex: 0, braceDepth: 0 })
    } else if (t.value === ')') {
      stack.pop()
    } else if (t.value === '{') {
      const top = stack[stack.length - 1]
      if (top) top.braceDepth++
    } else if (t.value === '}') {
      const top = stack[stack.length - 1]
      if (top && top.braceDepth > 0) top.braceDepth--
    } else if (t.value === ',') {
      const top = stack[stack.length - 1]
      if (top && top.braceDepth === 0) top.argIndex++
    }
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i]!
    if (!frame.name) continue
    const sig = functionSig(frame.name)
    if (!sig) continue
    const highlightIndex = mapArgIndex(sig, frame.argIndex)
    return { sig, argIndex: frame.argIndex, highlightIndex }
  }
  return null
}

function mapArgIndex(sig: FunctionSig, argIndex: number): number {
  const n = sig.args.length
  if (n === 0) return -1
  if (argIndex < n) return argIndex
  const firstRepeat = sig.args.findIndex((a) => a.repeat)
  if (firstRepeat < 0) return n - 1
  const period = n - firstRepeat
  return firstRepeat + ((argIndex - firstRepeat) % period)
}

export type FormulaRefHighlight = {
  start: number
  end: number
  raw: string
  sheet: string | null
  range: Range
  color: string
}

type ParsedA1 = {
  workbookName?: string
  sheetName?: string
  range?: { top: number | null; left: number | null; bottom: number | null; right: number | null }
}

/** Extracts cell/range references in `text` with deterministic per-reference colours. */
export function formulaReferences(text: string): FormulaRefHighlight[] {
  if (!text.startsWith('=')) return []
  const toks = spanTokens(text.slice(1))
  const out: FormulaRefHighlight[] = []
  const colors = new Map<string, string>()
  let colorIdx = 0
  for (const t of toks) {
    if (t.type !== 'range' && t.type !== 'range_beam') continue
    const ref = parseA1Ref(t.value) as ParsedA1 | undefined
    const r = ref?.range
    if (!ref || !r || ref.workbookName) continue
    if (r.top === null && r.left === null) continue
    const top = r.top ?? 0
    const bottom = r.bottom ?? (r.top === null ? MAX_ROWS - 1 : top)
    const left = r.left ?? 0
    const right = r.right ?? (r.left === null ? MAX_COLS - 1 : left)
    const norm: Range = {
      top: Math.min(top, bottom),
      bottom: Math.max(top, bottom),
      left: Math.min(left, right),
      right: Math.max(left, right),
    }
    const key = `${(ref.sheetName ?? '').toLowerCase()}!${norm.top}:${norm.left}:${norm.bottom}:${norm.right}`
    let color = colors.get(key)
    if (!color) {
      color = REF_COLORS[colorIdx % REF_COLORS.length]!
      colors.set(key, color)
      colorIdx++
    }
    out.push({
      start: t.start + 1,
      end: t.end + 1,
      raw: t.value,
      sheet: ref.sheetName ?? null,
      range: norm,
      color,
    })
  }
  return out
}

export type FormulaRun = { text: string; color?: string }

/** Splits `text` into display segments so references match their grid border colour. */
export function formulaHighlightRuns(text: string): FormulaRun[] {
  const refs = formulaReferences(text)
  if (refs.length === 0) return [{ text }]
  const out: FormulaRun[] = []
  let pos = 0
  for (const r of refs) {
    if (r.start > pos) out.push({ text: text.slice(pos, r.start) })
    out.push({ text: text.slice(r.start, r.end), color: r.color })
    pos = r.end
  }
  if (pos < text.length) out.push({ text: text.slice(pos) })
  return out
}

/** True when clicking/dragging cells on the grid should insert or replace a reference at `cursor`. */
export function canInsertReferenceAt(
  text: string,
  selStart: number,
  selEnd = selStart,
  activePointRange?: [number, number] | null,
): boolean {
  if (!text.startsWith('=')) return false
  if (activePointRange) return true
  const pos = Math.min(selStart, selEnd)
  if (pos < 1) return false
  const body = text.slice(1)
  const rel = pos - 1
  const toks = spanTokens(body)
  // Inside a string literal: do not point-insert
  const insideString = toks.find((t) => t.type === 'string' && rel > t.start && rel < t.end)
  if (insideString) return false
  if (rel === 0) return true
  // Right after an operator that takes an operand (`=`, `(`, `,`, `;`, `:`, `+`, `-`, `*`, `/`, `^`, `&`, `<`, `>`, whitespace)
  const before = text.slice(0, pos).trimEnd()
  const lastChar = before[before.length - 1] ?? ''
  if ('=(,;+-*/^&<>:'.includes(lastChar)) return true
  // Or cursor sits on/at the end of a ref token
  const onRef = toks.find(
    (t) => (t.type === 'range' || t.type === 'range_beam') && rel >= t.start && rel <= t.end,
  )
  return !!onRef
}

export function formatPickedRef(
  refText: string,
  targetSheet: string,
  formulaSheet: string,
): string {
  return targetSheet.toLowerCase() === formulaSheet.toLowerCase()
    ? refText
    : `${quoteSheet(targetSheet)}!${refText}`
}

/** Inserts or updates the point-to-select reference in `text`. */
export function insertReferenceAt(
  text: string,
  selStart: number,
  selEnd: number,
  refText: string,
  activePointRange?: [number, number] | null,
): { text: string; refStart: number; refEnd: number } {
  let from = Math.min(selStart, selEnd)
  let to = Math.max(selStart, selEnd)
  if (activePointRange) {
    from = Math.max(1, Math.min(activePointRange[0], text.length))
    to = Math.max(from, Math.min(activePointRange[1], text.length))
  } else if (from === to && from > 1) {
    const toks = spanTokens(text.slice(1))
    const rel = from - 1
    const hit = toks.find(
      (t) => (t.type === 'range' || t.type === 'range_beam') && rel >= t.start && rel <= t.end,
    )
    if (hit) {
      from = hit.start + 1
      to = hit.end + 1
    }
  }
  const next = `${text.slice(0, from)}${refText}${text.slice(to)}`
  return { text: next, refStart: from, refEnd: from + refText.length }
}

// ---------------------------------------------------------------------------
// F4: cycle `$` absolute locks on a reference token

type LockPair = { $col: boolean; $row: boolean }

const CYCLE: LockPair[] = [
  { $col: false, $row: false },
  { $col: true, $row: true },
  { $col: false, $row: true },
  { $col: true, $row: false },
]

function nextLock($col: boolean, $row: boolean): LockPair {
  const idx = CYCLE.findIndex((p) => p.$col === $col && p.$row === $row)
  return CYCLE[(idx + 1) % CYCLE.length]!
}

type FullParsedRef = ParsedA1 & {
  range?: {
    top: number | null
    left: number | null
    bottom: number | null
    right: number | null
    $top?: boolean
    $left?: boolean
    $bottom?: boolean
    $right?: boolean
  }
}

/**
 * Cycles `$` locks (`A1` -> `$A$1` -> `A$1` -> `$A1` -> `A1`) on the reference
 * under or adjacent to `cursor` (or spanning `selStart..selEnd`).
 */
export function cycleAbsoluteAt(
  text: string,
  selStart: number,
  selEnd = selStart,
): { text: string; selStart: number; selEnd: number } | null {
  if (!text.startsWith('=')) return null
  const lo = Math.max(1, Math.min(selStart, selEnd)) - 1
  const hi = Math.max(1, Math.max(selStart, selEnd)) - 1
  const toks = spanTokens(text.slice(1))
  const hit = toks.find(
    (t) => (t.type === 'range' || t.type === 'range_beam') && hi >= t.start && lo <= t.end,
  )
  if (!hit) return null
  const ref = parseA1Ref(hit.value) as FullParsedRef | undefined
  const r = ref?.range
  if (!ref || !r) return null

  const colonIdx = hit.value.indexOf(':')
  const wholeOrBoth = colonIdx < 0 || lo !== hi || hi === hit.end || lo <= hit.start
  const inFirst = colonIdx >= 0 && !wholeOrBoth && lo <= hit.start + colonIdx
  const inSecond = colonIdx >= 0 && !wholeOrBoth && lo > hit.start + colonIdx

  const nextR = { ...r }
  if (colonIdx < 0) {
    const p = nextLock(!!r.$left, !!r.$top)
    if (r.left !== null) {
      nextR.$left = p.$col
      nextR.$right = p.$col
    }
    if (r.top !== null) {
      nextR.$top = p.$row
      nextR.$bottom = p.$row
    }
  } else {
    if (wholeOrBoth || inFirst) {
      const p = nextLock(!!r.$left, !!r.$top)
      if (r.left !== null) nextR.$left = p.$col
      if (r.top !== null) nextR.$top = p.$row
    }
    if (wholeOrBoth || inSecond) {
      const p = wholeOrBoth ? nextLock(!!r.$left, !!r.$top) : nextLock(!!r.$right, !!r.$bottom)
      if (r.right !== null) nextR.$right = p.$col
      if (r.bottom !== null) nextR.$bottom = p.$row
    }
  }

  const replacement = stringifyA1Ref({ ...ref, range: nextR } as never)
  const nextText = `${text.slice(0, hit.start + 1)}${replacement}${text.slice(hit.end + 1)}`
  const start = hit.start + 1
  return { text: nextText, selStart: start, selEnd: start + replacement.length }
}
