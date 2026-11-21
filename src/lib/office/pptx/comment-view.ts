import type { SlideComment } from './comments'
import type { Deck, Slide } from './model'
import { effectiveXfrm } from './ops'

/**
 * What the viewer shows of a slide's comments: where each open thread's
 * marker sits, and the counts on the thumbnails. Resolved threads keep no
 * marker on the slide (they stay in the comments panel).
 */

export type MarkerSpot = {
  id: string
  /** 1-based, in the slide's comment order. */
  n: number
  /** Fractions of the slide's width and height (0–1). */
  x: number
  y: number
  legacy: boolean
}

/** Threads that still want attention: open modern ones and every legacy one (legacy has no status). */
export const isOpen = (t: SlideComment) => t.format === 'legacy' || t.status === 'active'

export const openCount = (slide: Slide) => slide.comments.threads.filter(isOpen).length

/**
 * A marker for each open thread: at its position when it has one, else at the
 * top-right corner of the shape it is on, else in the slide's top-left corner
 * (stacked, so none hides another).
 */
export function markerSpots(deck: Deck, slide: Slide): MarkerSpot[] {
  const { cx, cy } = deck.size
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  let loose = 0
  const out: MarkerSpot[] = []
  slide.comments.threads.forEach((t, i) => {
    if (!isOpen(t)) return
    let at: { x: number; y: number } | null = t.pos
    if (!at && t.anchor.kind !== 'slide') {
      const id = t.anchor.shape
      const node = slide.shapes.find((s) => s.id === id)
      const x = node ? effectiveXfrm(deck, slide, node) : null
      if (x) at = { x: x.x + x.cx, y: x.y }
    }
    if (!at) {
      at = { x: 0, y: loose * cy * 0.06 }
      loose++
    }
    out.push({ id: t.id, n: i + 1, x: clamp(at.x / cx), y: clamp(at.y / cy), legacy: t.format === 'legacy' })
  })
  return out
}

/** The name of the shape a comment is on (by its id), or null when the slide has no such shape. */
export function anchorName(slide: Slide, t: SlideComment): string | null {
  if (t.anchor.kind === 'slide') return null
  const id = t.anchor.shape
  return slide.shapes.find((s) => s.id === id)?.name || null
}
