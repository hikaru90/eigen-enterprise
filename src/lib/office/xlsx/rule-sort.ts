import { cellName, type Range } from './ref'
import { translateFormula } from './shift'
import { anchorOf, overlaps, parseSqref, sqrefText, subtractAll } from './sqref'
import { all, kid, kids, setText, textOf } from './xml'

/**
 * Conditional formats and data validations move with sorted cells, as in
 * Excel: a rule that covers only some of the sorted rows follows those
 * cells to their new rows (its range is rebuilt from the moved cells); a
 * rule over every sorted row of its columns stays as it is. A rule whose
 * first cell moved keeps its relative formulas meaning the same cells (they
 * are re-anchored, ./sqref.ts anchorOf). Main and Excel 2010 lists alike.
 */

const NS_X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const NS_XM = 'http://schemas.microsoft.com/office/excel/2006/main'
const X14_CF_URI = '{78C0D931-6437-407d-A8EE-F0AAD7539E65}'
const X14_DV_URI = '{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}'

type Target = {
  ranges: Range[]
  write: (ranges: Range[]) => void
  formulas: Element[]
}

/** Cells (row → columns) as rectangles: column runs of rows, merged across equal neighbouring columns. */
function cellsToRanges(cells: Map<number, Set<number>>): Range[] {
  const byCol = new Map<number, number[]>()
  for (const [r, cs] of cells) for (const c of cs) byCol.set(c, [...(byCol.get(c) ?? []), r])
  const runs: Range[] = []
  for (const [c, rs] of [...byCol].sort((a, b) => a[0] - b[0])) {
    rs.sort((a, b) => a - b)
    let start = rs[0]!
    for (let i = 1; i <= rs.length; i++) {
      if (i < rs.length && rs[i] === rs[i - 1]! + 1) continue
      const top = start
      const bottom = rs[i - 1]!
      const prev = runs.find((x) => x.top === top && x.bottom === bottom && x.right === c - 1)
      if (prev) prev.right = c
      else runs.push({ top, bottom, left: c, right: c })
      start = rs[i]!
    }
  }
  return runs.sort((a, b) => a.top - b.top || a.left - b.left)
}

function moveTarget(doc: XMLDocument, t: Target, body: Range, dest: Map<number, number>) {
  if (!t.ranges.some((r) => overlaps(r, body))) return
  const moved = [...dest.keys()]
  // Which moved rows each column of the body covers; a column covering all of them is unchanged by the sort.
  const covered = new Map<number, Set<number>>()
  let changes = false
  for (let c = body.left; c <= body.right; c++) {
    const rows = moved.filter((r) => t.ranges.some((x) => r >= x.top && r <= x.bottom && c >= x.left && c <= x.right))
    if (rows.length > 0 && rows.length < moved.length) changes = true
  }
  if (!changes) return
  for (const x of t.ranges) {
    const top = Math.max(x.top, body.top)
    const bottom = Math.min(x.bottom, body.bottom)
    const left = Math.max(x.left, body.left)
    const right = Math.min(x.right, body.right)
    for (let r = top; r <= bottom; r++)
      for (let c = left; c <= right; c++) {
        const to = dest.get(r) ?? r
        let set = covered.get(to)
        if (!set) covered.set(to, (set = new Set()))
        set.add(c)
      }
  }
  const next = [...subtractAll(t.ranges, [body]), ...cellsToRanges(covered)]
  const from = cellName(anchorOf(t.ranges))
  const to = cellName(anchorOf(next))
  if (from !== to)
    for (const f of t.formulas) {
      const text = textOf(f)
      if (text !== '') setText(doc, f, translateFormula(text, from, to))
    }
  t.write(next)
}

function extOf(root: Element, uri: string): Element | null {
  const lst = kid(root, 'extLst')
  return (lst ? kids(lst, 'ext') : []).find((e) => e.getAttribute('uri') === uri) ?? null
}

export function moveRulesWithSort(doc: XMLDocument, body: Range, dest: Map<number, number>) {
  if (dest.size === 0) return
  const root = doc.documentElement!
  const targets: Target[] = []
  for (const cf of kids(root, 'conditionalFormatting'))
    targets.push({
      ranges: parseSqref(cf.getAttribute('sqref') ?? ''),
      write: (r) => cf.setAttribute('sqref', sqrefText(r)),
      formulas: kids(cf, 'cfRule').flatMap((rule) => kids(rule, 'formula')),
    })
  const dvs = kid(root, 'dataValidations')
  for (const dv of dvs ? kids(dvs, 'dataValidation') : [])
    targets.push({
      ranges: parseSqref(dv.getAttribute('sqref') ?? ''),
      write: (r) => dv.setAttribute('sqref', sqrefText(r)),
      formulas: [...kids(dv, 'formula1'), ...kids(dv, 'formula2')],
    })
  const x14 = (uri: string, list: string, item: string) => {
    const ext = extOf(root, uri)
    const holder = ext ? kid(ext, list, NS_X14) : null
    for (const el of holder ? kids(holder, item, NS_X14) : []) {
      const sq = kid(el, 'sqref', NS_XM)
      if (!sq) continue
      targets.push({
        ranges: parseSqref(textOf(sq)),
        write: (r) => setText(doc, sq, sqrefText(r)),
        formulas: all(el, 'f', NS_XM),
      })
    }
  }
  x14(X14_CF_URI, 'conditionalFormattings', 'conditionalFormatting')
  x14(X14_DV_URI, 'dataValidations', 'dataValidation')
  for (const t of targets) moveTarget(doc, t, body, dest)
}
