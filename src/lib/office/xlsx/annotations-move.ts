import type { SheetInfo, Workbook } from './workbook'
import {
  NS_THREADED,
  readNotes,
  removeLegacyComment,
  threadedPartOf,
  writeLegacyComment,
  type SheetDocSource,
} from './notes'
import { cellName, type Range } from './ref'
import { dropEmptyThreadedPart, ensureThreadedPart, readThreads, syncStandIn } from './threads'
import { all } from './xml'

/**
 * Cut and paste (./clip.ts): notes and comment threads on the cut cells move
 * with them, as in Excel — to the same offset on the target sheet, replacing
 * the notes and threads the target cells had (the pasted cells replace those
 * cells whole). Pictures, shapes and charts stay where they are (Excel moves
 * objects only with whole rows/columns, ./drawing.ts). A thread keeps its
 * ids, authors, dates, replies, mentions and resolved state; a note keeps its
 * text, author and whether it is shown. Nothing on the cut cells: no part is
 * touched.
 */
export function moveAnnotationsForCut(
  wb: Workbook,
  src: SheetInfo,
  dst: SheetInfo,
  srcDoc: SheetDocSource,
  dstDoc: SheetDocSource,
  from: Range,
  dr: number,
  dc: number,
) {
  const inRange = (r: Range, row: number, col: number) =>
    row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
  const to: Range = { top: from.top + dr, bottom: from.bottom + dr, left: from.left + dc, right: from.right + dc }
  const notes = readNotes(wb, src).filter((n) => inRange(from, n.row, n.col))
  const threads = readThreads(wb, src).filter((t) => inRange(from, t.row, t.col))
  const movedRefs = new Set([...notes.map((n) => n.ref), ...threads.map((t) => t.ref)])
  const same = src.part === dst.part
  const replaced = {
    notes: readNotes(wb, dst).filter((n) => inRange(to, n.row, n.col) && !(same && movedRefs.has(n.ref))),
    threads: readThreads(wb, dst).filter((t) => inRange(to, t.row, t.col) && !(same && movedRefs.has(t.ref))),
  }
  if (notes.length + threads.length + replaced.notes.length + replaced.threads.length === 0) return

  // The threads' own elements (every comment and reply), taken out of the source.
  const threadEls = new Map<string, Element[]>()
  const srcPart = threadedPartOf(wb, src)
  if (srcPart && threads.length > 0) {
    const doc = wb.edit(srcPart)
    const ids = new Map(threads.map((t) => [t.id, t.ref]))
    for (const el of all(doc, 'threadedComment', NS_THREADED)) {
      const root = el.getAttribute('parentId') ?? el.getAttribute('id') ?? ''
      const ref = ids.get(root)
      if (ref === undefined) continue
      el.parentNode!.removeChild(el)
      threadEls.set(ref, [...(threadEls.get(ref) ?? []), el])
    }
  }
  for (const ref of movedRefs) removeLegacyComment(wb, src, srcDoc, ref)

  // What the target cells had goes (the paste replaces those cells).
  const dstPart = threadedPartOf(wb, dst)
  if (dstPart && replaced.threads.length > 0) {
    const doc = wb.edit(dstPart)
    const gone = new Set(replaced.threads.map((t) => t.id))
    for (const el of all(doc, 'threadedComment', NS_THREADED))
      if (gone.has(el.getAttribute('parentId') ?? el.getAttribute('id') ?? '')) el.parentNode!.removeChild(el)
  }
  for (const n of replaced.notes) removeLegacyComment(wb, dst, dstDoc, n.ref)
  for (const t of replaced.threads) removeLegacyComment(wb, dst, dstDoc, t.ref)

  // And the moved ones arrive.
  const place = (row: number, col: number) => cellName({ row: row + dr, col: col + dc })
  for (const n of notes) writeLegacyComment(wb, dst, dstDoc, place(n.row, n.col), n.text, n.author, n.visible)
  if (threads.length > 0) {
    const part = ensureThreadedPart(wb, dst)
    const doc = wb.edit(part)
    for (const t of threads) {
      const ref = place(t.row, t.col)
      for (const el of threadEls.get(t.ref) ?? []) {
        const copy = doc.importNode(el, true) as Element
        copy.setAttribute('ref', ref)
        doc.documentElement!.appendChild(copy)
      }
      syncStandIn(wb, dst, dstDoc, ref)
    }
  }
  dropEmptyThreadedPart(wb, src)
  if (!same) dropEmptyThreadedPart(wb, dst)
}
