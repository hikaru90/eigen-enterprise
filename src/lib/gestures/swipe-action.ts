import type { Action } from 'svelte/action'
import { type Swipe, type SwipeOptions, type SwipePoint, SwipeTracker } from './swipe'

/**
 * `use:swipe={{ onswipe }}`: horizontal swipes on an element (Contribute b6625f4c),
 * recognised by SwipeTracker. Give the element `touch-action: pan-y` so the
 * browser keeps vertical scrolling and hands sideways movement to the page.
 * The tap a swipe ends on is not also a click. The element is marked
 * `data-own-swipe`, so the shell's sideways gesture (side-swipe-action.ts)
 * leaves touches on it alone.
 */
export type SwipeParams = { onswipe: (swipe: Swipe) => void; options?: Partial<SwipeOptions> }

const CLICK_GUARD_MS = 400

export const swipe: Action<HTMLElement, SwipeParams> = (node, initial) => {
  let params = initial
  const tracker = new SwipeTracker(params.options)
  const point = (e: PointerEvent): SwipePoint => ({
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    isPrimary: e.isPrimary,
    x: e.clientX,
    y: e.clientY,
    t: e.timeStamp,
  })

  /** Clicks inside the element until then belong to the swipe that just ended. */
  let guardUntil = -Infinity
  const click = (e: MouseEvent) => {
    if (e.timeStamp > guardUntil) return
    e.preventDefault()
    e.stopPropagation()
  }

  const down = (e: PointerEvent) => tracker.down(point(e))
  const move = (e: PointerEvent) => void tracker.move(point(e))
  const up = (e: PointerEvent) => {
    const s = tracker.up(point(e))
    if (!s) return
    guardUntil = e.timeStamp + CLICK_GUARD_MS
    params.onswipe(s)
  }
  const cancel = (e: PointerEvent) => tracker.cancel(e.pointerId)

  node.dataset.ownSwipe = ''
  node.addEventListener('pointerdown', down)
  node.addEventListener('pointermove', move)
  node.addEventListener('pointerup', up)
  node.addEventListener('pointercancel', cancel)
  node.addEventListener('click', click, { capture: true })
  return {
    // A new handler mid-gesture keeps the gesture; thresholds are set once, at mount.
    update(next) {
      params = next
    },
    destroy() {
      delete node.dataset.ownSwipe
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('click', click, { capture: true })
    },
  }
}
