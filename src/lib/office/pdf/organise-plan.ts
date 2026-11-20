/**
 * Organising a PDF's pages as a plan (plan/phase-office-files.md, P2): the
 * pages the new file will have, in order — each one a page of some source
 * PDF with the rotation to add to it, or a blank page. Rotating, deleting,
 * moving and inserting are edits of that list; ./organise.ts turns a plan
 * into a PDF in one pass. Pure and dependency-free, so the viewer stages
 * changes (and undoes them) without loading the PDF writer.
 *
 * Page indices here are 0-based; the agent tools speak 1-based numbers.
 */

/** Clockwise quarter turns, in degrees. */
export type Rotation = 0 | 90 | 180 | 270

export type PageSlot =
  /** Page `page` of source `source`, turned by `rotate` on top of its own rotation. */
  | { kind: 'page'; source: number; page: number; rotate: Rotation }
  /** A new empty page, `width` × `height` points as it is seen. */
  | { kind: 'blank'; width: number; height: number }

export type PagePlan = readonly PageSlot[]

/** An organise request that can't be done (a page that isn't there, no pages left, …). */
export class PdfOrganiseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfOrganiseError'
  }
}

/** A rotation turned by `by` degrees (any multiple of 90, negative = anticlockwise). */
export function turn(rotation: number, by: number): Rotation {
  if (!Number.isInteger(rotation / 90) || !Number.isInteger(by / 90))
    throw new PdfOrganiseError(`Pages turn in steps of 90°, not ${by}°.`)
  return ((((rotation + by) % 360) + 360) % 360) as Rotation
}

/** Every page of `source` (`count` pages), unchanged. */
export function wholeDocument(count: number, source = 0): PageSlot[] {
  return Array.from(
    { length: count },
    (_, page) => ({ kind: 'page', source, page, rotate: 0 }) as const,
  )
}

/** Checks a list of 0-based page indices against `count` pages: distinct, in range, sorted. */
export function checkedPages(pages: readonly number[], count: number): number[] {
  if (pages.length === 0) throw new PdfOrganiseError('Choose at least one page.')
  const seen = new Set<number>()
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 0 || p >= count)
      throw new PdfOrganiseError(
        `There is no page ${Number.isInteger(p) ? p + 1 : p}; the PDF has ${count} ${count === 1 ? 'page' : 'pages'}.`,
      )
    if (seen.has(p)) throw new PdfOrganiseError(`Page ${p + 1} is named twice.`)
    seen.add(p)
  }
  return [...seen].sort((a, b) => a - b)
}

/** Turns the pages at `indices` by `by` degrees. */
export function planRotate<T extends PageSlot>(
  plan: readonly T[],
  indices: readonly number[],
  by: number,
): T[] {
  const chosen = new Set(checkedPages(indices, plan.length))
  return plan.map((slot, i) => {
    if (!chosen.has(i)) return slot
    if (slot.kind === 'blank') {
      // A blank page has no content to turn: it swaps its sides on a quarter turn.
      return turn(0, by) % 180 === 0 ? slot : { ...slot, width: slot.height, height: slot.width }
    }
    return { ...slot, rotate: turn((slot as T & { kind: 'page' }).rotate, by) }
  })
}

/** Removes the pages at `indices`; at least one page must stay. */
export function planDelete<T extends PageSlot>(
  plan: readonly T[],
  indices: readonly number[],
): T[] {
  const chosen = new Set(checkedPages(indices, plan.length))
  if (chosen.size === plan.length)
    throw new PdfOrganiseError('A PDF needs at least one page, so not every page can be deleted.')
  return plan.filter((_, i) => !chosen.has(i))
}

/**
 * Moves the pages at `indices` (kept in their order) so that the first of
 * them ends up at position `to` of the result (0-based; at most
 * `plan.length - indices.length`).
 */
export function planMove<T extends PageSlot>(
  plan: readonly T[],
  indices: readonly number[],
  to: number,
): T[] {
  const moved = checkedPages(indices, plan.length)
  const rest = plan.filter((_, i) => !moved.includes(i))
  if (!Number.isInteger(to) || to < 0 || to > rest.length)
    throw new PdfOrganiseError(
      `Moved pages can start at position 1 to ${rest.length + 1}, not ${Number.isInteger(to) ? to + 1 : to}.`,
    )
  return [...rest.slice(0, to), ...moved.map((i) => plan[i]!), ...rest.slice(to)]
}

/**
 * Where moved pages land when they are dropped before the page now at
 * `before` (0 … plan.length; plan.length = at the end): the `to` of planMove.
 */
export function dropTarget(indices: readonly number[], before: number): number {
  return before - indices.filter((i) => i < before).length
}

/** A new order as a permutation of every page (0-based indices in their new order). */
export function planReorder<T extends PageSlot>(plan: readonly T[], order: readonly number[]): T[] {
  if (order.length !== plan.length)
    throw new PdfOrganiseError(
      `The new order must list every page once: the PDF has ${plan.length} pages, the order names ${order.length}.`,
    )
  const listed = checkedPages(order, plan.length)
  if (listed.length !== plan.length)
    throw new PdfOrganiseError('The new order must list every page once.')
  return order.map((i) => plan[i]!)
}

/** Inserts `slots` before position `at` (0 … plan.length). */
export function planInsert<T extends PageSlot>(
  plan: readonly T[],
  at: number,
  slots: readonly T[],
): T[] {
  if (!Number.isInteger(at) || at < 0 || at > plan.length)
    throw new PdfOrganiseError(
      `Pages can be inserted at position 1 to ${plan.length + 1}, not ${Number.isInteger(at) ? at + 1 : at}.`,
    )
  return [...plan.slice(0, at), ...slots, ...plan.slice(at)]
}

/** The pages at `indices`, in document order (what "extract" takes). */
export function planPick<T extends PageSlot>(plan: readonly T[], indices: readonly number[]): T[] {
  return checkedPages(indices, plan.length).map((i) => plan[i]!)
}

/** Whether a plan is just the pages of source 0 as they are (nothing to save). */
export function isUnchanged(plan: PagePlan, count: number): boolean {
  return (
    plan.length === count &&
    plan.every((s, i) => s.kind === 'page' && s.source === 0 && s.page === i && s.rotate === 0)
  )
}

/** "2–4, 7" for the pages 2, 3, 4 and 7 (page numbers, as people say them). */
export function pageRangesLabel(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j === i ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`)
    i = j
  }
  return parts.join(', ')
}
