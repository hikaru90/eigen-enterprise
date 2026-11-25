import { tokenize } from '@borgar/fx/xlsx'

/**
 * A formula as people type it ↔ as the file stores it (ECMA-376 Part 1
 * §18.17.7, [MS-XLSX] 2.2.2): functions newer than Excel 2007 carry
 * `_xlfn.` (worksheet-only ones `_xlfn._xlws.`), LET/LAMBDA parameter
 * names `_xlpm.`, a spill reference `A1#` is `_xlfn.ANCHORARRAY(A1)` and the
 * implicit-intersection operator `@x` is `_xlfn.SINGLE(x)`. Only tokens
 * change; everything else is written back as it was.
 */

type Tok = { type: string; value: string }
const toks = (f: string) => tokenize(f, { mergeRefs: true }) as Tok[]
const PREFIX = /^_xlfn\.(_xlws\.)?|^_xlws\./i
const PARAM = /^_xlpm\./i

/** Index of the ")" matching the "(" at `open`. */
function closing(t: Tok[], open: number): number {
  let depth = 0
  for (let i = open; i < t.length; i++) {
    if (t[i]!.type !== 'operator') continue
    if (t[i]!.value === '(') depth++
    else if (t[i]!.value === ')' && --depth === 0) return i
  }
  return t.length - 1
}

const isFunc = (t: Tok | undefined, name: string) =>
  t?.type === 'func' && t.value.replace(PREFIX, '').toUpperCase() === name
const isOp = (t: Tok | undefined, v: string) => t?.type === 'operator' && t.value === v

/** The names LET and LAMBDA declare, as the token positions where each is in scope. */
function paramScopes(t: Tok[]): Array<{ name: string; from: number; to: number }> {
  const out: Array<{ name: string; from: number; to: number }> = []
  for (let i = 0; i < t.length; i++) {
    const isLet = isFunc(t[i], 'LET')
    if ((!isLet && !isFunc(t[i], 'LAMBDA')) || !isOp(t[i + 1], '(')) continue
    const open = i + 1
    const end = closing(t, open)
    // The frame's arguments as token ranges.
    const args: Array<[number, number]> = []
    let depth = 0
    let start = open + 1
    for (let k = open + 1; k < end; k++) {
      const x = t[k]!
      if (x.type !== 'operator') continue
      if (x.value === '(' || x.value === '{') depth++
      else if (x.value === ')' || x.value === '}') depth--
      else if (x.value === ',' && depth === 0) {
        args.push([start, k])
        start = k + 1
      }
    }
    args.push([start, end])
    const single = ([a, b]: [number, number]) => {
      const inner = t
        .slice(a, b)
        .map((x, k) => [x, a + k] as const)
        .filter(([x]) => x.type !== 'whitespace')
      return inner.length === 1 && inner[0]![0].type === 'range_named' ? inner[0]![1] : -1
    }
    args.slice(0, -1).forEach((arg, n) => {
      if (isLet && n % 2 === 1) return
      const at = single(arg)
      if (at >= 0)
        out.push({
          name: t[at]!.value.replace(PARAM, '').toLowerCase(),
          from: isLet ? at : open,
          to: end,
        })
    })
  }
  return out
}

/** Newer functions prefixed, parameter names prefixed, `#` and `@` spelled the way files store them. */
export function toFileText(
  formula: string,
  future: ReadonlySet<string>,
  worksheetOnly: ReadonlySet<string>,
): string {
  const t = toks(formula)
  const scopes = paramScopes(t)
  const closeAfter = new Map<number, number>()
  const out: string[] = []
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!
    if (x.type === 'func') {
      const bare = x.value.replace(PREFIX, '')
      const up = bare.toUpperCase()
      out.push(
        worksheetOnly.has(up) ? `_xlfn._xlws.${bare}` : future.has(up) ? `_xlfn.${bare}` : bare,
      )
    } else if (x.type === 'range_named') {
      const bare = x.value.replace(PARAM, '')
      const k = bare.toLowerCase()
      out.push(
        scopes.some((s) => s.name === k && i >= s.from && i <= s.to) ? `_xlpm.${bare}` : bare,
      )
    } else if (isOp(x, '#') && out.length > 0 && t[i - 1]?.type === 'range') {
      out.push(`_xlfn.ANCHORARRAY(${out.pop()})`)
    } else if (isOp(x, '@')) {
      const next = t[i + 1]
      if (isOp(next, '(')) out.push('_xlfn.SINGLE')
      else {
        let end = -1
        if (next && ['range', 'range_named', 'structured'].includes(next.type)) end = i + 1
        else if (next?.type === 'func' && isOp(t[i + 2], '(')) end = closing(t, i + 2)
        if (end < 0) out.push(x.value)
        else {
          out.push('_xlfn.SINGLE(')
          closeAfter.set(end, (closeAfter.get(end) ?? 0) + 1)
        }
      }
    } else out.push(x.value)
    const closes = closeAfter.get(i)
    if (closes) out.push(')'.repeat(closes))
  }
  return out.join('')
}

const stringify = (t: Tok[]) => t.map((x) => x.value).join('')

/** As people read it: no prefixes, `A1#` and `@x` back. */
export function toShownText(formula: string): string {
  const t = toks(formula)
  const out: string[] = []
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!
    if (
      isFunc(x, 'ANCHORARRAY') &&
      isOp(t[i + 1], '(') &&
      t[i + 2]?.type === 'range' &&
      isOp(t[i + 3], ')')
    ) {
      out.push(`${t[i + 2]!.value}#`)
      i += 3
    } else if (isFunc(x, 'SINGLE') && isOp(t[i + 1], '(')) {
      const end = closing(t, i + 1)
      const inner = t.slice(i + 2, end)
      const text = toShownText(stringify(inner))
      const simple = inner.length === 1 && inner[0]!.type !== 'operator'
      const call = inner[0]?.type === 'func' && closing(inner, 1) === inner.length - 1
      out.push(simple || call ? `@${text}` : `@(${text})`)
      i = end
    } else if (x.type === 'func') out.push(x.value.replace(PREFIX, ''))
    else if (x.type === 'range_named') out.push(x.value.replace(PARAM, ''))
    else out.push(x.value)
  }
  return out.join('')
}
