import type { Workbook } from './workbook'
import { cfRulesOf, inputOf, runCfOp, type CfRuleInput, type CfRuleView } from './cond-format'
import { cellName, type Range } from './ref'
import { translateFormula } from './shift'
import { anchorOf, sqrefText } from './sqref'
import {
  runValidationOp,
  validationsOf,
  type ValidationRule,
  type ValidationView,
} from './validation'

/**
 * Conditional formats and data validations travel with copied, cut and
 * filled cells, as in Excel: Paste (all) gives the target the source's
 * rules and validations — the target's own go first (pasting is
 * formatting); Paste Formats brings the conditional formats only; Cut moves
 * them (the source cells lose theirs); Fill repeats the source block's rules
 * over the filled cells. Relative formulas follow the cells (like a copied
 * formula); absolute ones stay. A transposed paste brings no rules (their
 * ranges and formulas have no transposed form in Excel's file).
 */

export type Carry = {
  srcSheet: string
  /** The source block. */
  src: Range
  dstSheet: string
  /** Top-left cells of each copy of the block on the target sheet. */
  tiles: Array<{ row: number; col: number }>
  /** Where the copies may go (a fill's last copy can be cut short). */
  area: Range
  cf: boolean
  dv: boolean
  cut: boolean
}

const intersect = (a: Range, b: Range): Range | null => {
  const r = {
    top: Math.max(a.top, b.top),
    left: Math.max(a.left, b.left),
    bottom: Math.min(a.bottom, b.bottom),
    right: Math.min(a.right, b.right),
  }
  return r.top <= r.bottom && r.left <= r.right ? r : null
}

const STYLED = new Set(['colorScale', 'dataBar', 'iconSet'])

/** A formula as written for `from` (rule anchor), as it reads written for `to`. */
const moveF = (f: string | undefined | null, from: string, to: string) =>
  f === undefined || f === null ? f : `=${translateFormula(f.replace(/^=/, ''), from, to)}`

function movedCf(view: CfRuleView, from: string, to: string): CfRuleInput {
  const input = inputOf(view)
  const formula1 = moveF(input.formula1, from, to)
  const formula2 = moveF(input.formula2, from, to)
  if (formula1 !== undefined && formula1 !== null) input.formula1 = formula1
  if (formula2 !== undefined && formula2 !== null) input.formula2 = formula2
  return input
}

function movedDv(view: ValidationView, from: string, to: string): ValidationRule {
  return {
    type: view.type,
    operator: view.operator,
    ...(view.items ? { items: view.items } : {}),
    ...(view.formula1 ? { formula1: moveF(view.formula1, from, to)! } : {}),
    ...(view.formula2 ? { formula2: moveF(view.formula2, from, to)! } : {}),
    allowBlank: view.allowBlank,
    dropdown: view.dropdown,
    inputTitle: view.inputTitle,
    inputMessage: view.inputMessage,
    errorStyle: view.errorStyle,
    errorTitle: view.errorTitle,
    errorMessage: view.errorMessage,
    showInput: view.showInput,
    showError: view.showError,
  }
}

/** The parts of `ranges` inside the source block, placed at each copy (clipped to the area). */
function placed(ranges: Range[], c: Carry): Range[] {
  const out: Range[] = []
  for (const t of c.tiles) {
    const dr = t.row - c.src.top
    const dc = t.col - c.src.left
    for (const r of ranges) {
      const part = intersect(r, c.src)
      if (!part) continue
      const moved = intersect(
        {
          top: part.top + dr,
          bottom: part.bottom + dr,
          left: part.left + dc,
          right: part.right + dc,
        },
        c.area,
      )
      if (moved) out.push(moved)
    }
  }
  return coalesce(out)
}

/** Neighbouring rectangles of the same width (stacked) or height (side by side) as one, until none join. */
function coalesce(list: Range[]): Range[] {
  const out = list.map((r) => ({ ...r }))
  for (let joined = true; joined;) {
    joined = false
    for (let i = 0; i < out.length && !joined; i++)
      for (let j = 0; j < out.length && !joined; j++) {
        if (i === j) continue
        const a = out[i]!
        const b = out[j]!
        if (a.left === b.left && a.right === b.right && a.bottom + 1 === b.top) a.bottom = b.bottom
        else if (a.top === b.top && a.bottom === b.bottom && a.right + 1 === b.left)
          a.right = b.right
        else continue
        out.splice(j, 1)
        joined = true
      }
  }
  return out
}

export function carryRules(wb: Workbook, c: Carry): string[] {
  if (!c.cf && !c.dv) return []
  const cfs = c.cf
    ? cfRulesOf(wb, c.srcSheet).filter((r) => r.ranges.some((x) => intersect(x, c.src)))
    : []
  const dvs = c.dv
    ? validationsOf(wb, c.srcSheet).filter((r) => r.ranges.some((x) => intersect(x, c.src)))
    : []
  // Cut: the source cells lose their rules; then the target's own rules go (the paste formats it anew).
  if (c.cut) {
    if (c.cf) runCfOp(wb, { op: 'cf_clear', sheet: c.srcSheet, range: sqrefText([c.src]) })
    if (c.dv)
      runValidationOp(wb, { op: 'validation_clear', sheet: c.srcSheet, range: sqrefText([c.src]) })
  }
  if (c.cf) runCfOp(wb, { op: 'cf_clear', sheet: c.dstSheet, range: sqrefText([c.area]) })
  if (c.dv)
    runValidationOp(wb, { op: 'validation_clear', sheet: c.dstSheet, range: sqrefText([c.area]) })
  // Lowest priority first: each new rule lands on top, so the source's order is kept.
  for (const view of [...cfs].reverse()) {
    if (!STYLED.has(view.type) && (!view.style || Object.keys(view.style).length === 0)) continue
    const ranges = placed(view.ranges, c)
    if (ranges.length === 0) continue
    const from = cellName(anchorOf(view.ranges))
    const to = cellName(anchorOf(ranges))
    runCfOp(wb, {
      op: 'cf_add',
      sheet: c.dstSheet,
      range: sqrefText(ranges),
      rule: movedCf(view, from, to),
    })
  }
  for (const view of dvs) {
    const ranges = placed(view.ranges, c)
    if (ranges.length === 0) continue
    const from = cellName(anchorOf(view.ranges))
    const to = cellName(anchorOf(ranges))
    runValidationOp(wb, {
      op: 'validation_set',
      sheet: c.dstSheet,
      range: sqrefText(ranges),
      rule: movedDv(view, from, to),
    })
  }
  return [...new Set([c.srcSheet, c.dstSheet])]
}
