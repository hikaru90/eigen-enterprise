import type { Workbook } from './workbook'
import { parse } from '@borgar/fx'
import { parseA1Ref, parseStructRef } from '@borgar/fx/xlsx'
import { DYNAMIC_ONLY, paramClass, REF_RESULT } from './calc-params'
import { parseableTokens } from './shift'

/**
 * Whether a typed formula must be written as a dynamic array (so Excel
 * reads it as the person meant it) rather than as a plain formula, which
 * Excel reads the old way: a range where one value goes is implicitly
 * intersected. Decided from the formula's structure (its parse tree and
 * Excel's parameter kinds), never from its current values: it spills, it
 * uses a function only dynamic-array Excel has, or a range meets an
 * operator or single-value parameter outside an array-evaluated argument.
 */

type Node = { type: string; [k: string]: unknown } | null
/** What an expression can be: one value, a reference that may span several cells, a computed array. */
type Kind = 'scalar' | 'multi' | 'array'

const PREFIX = /^_xlfn\.(_xlws\.)?|^_xlws\./i

const nonZero = (n: Node) => n?.type === 'Literal' && typeof n.value === 'number' && n.value !== 0

/** INDEX picking one cell for sure: a row and a column number, or one number into a one-row/one-column range. */
function singleIndex(args: Node[]): boolean {
  if (args.length >= 3) return nonZero(args[1] ?? null) && nonZero(args[2] ?? null)
  if (args.length !== 2 || !nonZero(args[1] ?? null)) return false
  const base = args[0]
  if (base?.type !== 'ReferenceIdentifier' || base.kind !== 'range') return false
  const ref = parseA1Ref(String(base.value)) as
    { range?: { top: number; left: number; bottom: number; right: number } } | undefined
  const r = ref?.range
  return !!r && (r.top === r.bottom || r.left === r.right)
}

export function needsDynamicArray(formula: string, wb: Workbook | null): boolean {
  const toks = parseableTokens(formula).map((t) =>
    t.type === 'func' ? { ...t, value: t.value.replace(PREFIX, '') } : t,
  )
  const root = parse(toks as never) as unknown as Node
  let needs = false
  const nameKinds = new Map<string, Kind>()

  const nameKind = (name: string, depth: number): Kind => {
    const k = name.toLowerCase()
    const hit = nameKinds.get(k)
    if (hit) return hit
    nameKinds.set(k, 'multi')
    const def = wb?.definedNames().find((n) => n.name.toLowerCase() === k)
    let kind: Kind = 'multi'
    if (def && depth < 10) {
      try {
        const dt = parseableTokens(def.formula).map((t) =>
          t.type === 'func' ? { ...t, value: t.value.replace(PREFIX, '') } : t,
        )
        kind = walk(parse(dt as never) as unknown as Node, false, depth + 1)
      } catch {
        kind = 'multi'
      }
    }
    nameKinds.set(k, kind)
    return kind
  }

  function walk(node: Node, arrayCtx: boolean, depth: number): Kind {
    if (node === null) return 'scalar'
    switch (node.type) {
      case 'Literal':
      case 'ErrorLiteral':
        return 'scalar'
      case 'ReferenceIdentifier': {
        const kind = node.kind as string
        const v = String(node.value)
        if (kind === 'beam') return 'multi'
        if (kind === 'range') return v.includes(':') ? 'multi' : 'scalar'
        if (kind === 'table') {
          const ref = parseStructRef(v) as { sections?: string[]; columns?: string[] } | undefined
          const thisRow = ref?.sections?.includes('this row')
          return thisRow && (ref?.columns?.length ?? 0) === 1 ? 'scalar' : 'multi'
        }
        return nameKind(v, depth)
      }
      case 'UnaryExpression': {
        const op = node.operator as string
        const [arg] = node.arguments as Node[]
        if (op === '#') {
          needs = true
          return 'multi'
        }
        const k = walk(arg!, arrayCtx, depth)
        if (op === '@') return 'scalar'
        if (k === 'multi' && !arrayCtx) needs = true
        return k === 'scalar' ? 'scalar' : 'array'
      }
      case 'BinaryExpression': {
        const op = node.operator as string
        const [l, r] = node.arguments as Node[]
        const kl = walk(l!, arrayCtx, depth)
        const kr = walk(r!, arrayCtx, depth)
        if (op === ':' || op === ' ' || op === ',') return 'multi'
        if ((kl === 'multi' || kr === 'multi') && !arrayCtx) needs = true
        return kl === 'scalar' && kr === 'scalar' ? 'scalar' : 'array'
      }
      case 'ArrayExpression':
        return 'array'
      case 'LambdaExpression':
      case 'LetExpression':
        needs = true
        return 'array'
      case 'CallExpression': {
        const callee = node.callee as { type: string; name?: string }
        const args = node.arguments as Node[]
        if (callee.type !== 'Identifier') {
          needs = true
          return 'array'
        }
        const name = (callee.name ?? '').toUpperCase()
        if (DYNAMIC_ONLY.has(name) || name === 'SINGLE') {
          if (name !== 'SINGLE') needs = true
          for (const a of args) walk(a, true, depth)
          return name === 'SINGLE' ? 'scalar' : 'array'
        }
        // A call to a LAMBDA kept as a defined name.
        if (wb?.definedNames().some((n) => n.name.toUpperCase() === name)) needs = true
        let lifted = false
        let rangeArg = false
        args.forEach((a, i) => {
          const cls = paramClass(name, i)
          const k = walk(a, arrayCtx || cls === 'array', depth)
          if (cls === 'value' && k !== 'scalar') {
            if (k === 'multi' && !arrayCtx) needs = true
            lifted = true
          }
          // ROW/COLUMN of a range: one number in older Excel, a list now.
          if ((name === 'ROW' || name === 'COLUMN') && k === 'multi') {
            rangeArg = true
            if (!arrayCtx) needs = true
          }
        })
        if (name === 'INDEX' && singleIndex(args)) return 'scalar'
        if (name === 'OFFSET' && args.length <= 3) return walk(args[0] ?? null, true, depth)
        if (REF_RESULT.has(name)) return 'multi'
        if (name === 'ROW' || name === 'COLUMN') return rangeArg ? 'array' : 'scalar'
        if (name === 'IF' || name === 'CHOOSE' || name === 'IFERROR' || name === 'IFNA') {
          const kinds = args
            .slice(name === 'IFERROR' || name === 'IFNA' ? 0 : 1)
            .map((a) => walk(a, arrayCtx, depth))
          if (kinds.includes('multi')) return 'multi'
          if (kinds.includes('array') || lifted) return 'array'
          return 'scalar'
        }
        return lifted ? 'array' : 'scalar'
      }
      default:
        needs = true
        return 'array'
    }
  }

  const k = walk(root, false, 0)
  return needs || k !== 'scalar'
}
