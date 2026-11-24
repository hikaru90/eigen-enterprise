import type { Action } from 'svelte/action'
import { WheelSwipeTracker } from './side-swipe'
import { type SwipeDirection, type SwipePoint, SwipeTracker } from './swipe'

/**
 * `use:sideSwipe={{ onswipe }}`: sideways scrolling anywhere inside the element
 * (owner, 2026-11-23) — a horizontal flick of one finger on touch screens, a
 * horizontal trackpad scroll (or Shift+wheel) on desktop. SwipeTracker and
 * WheelSwipeTracker recognise them.
 *
 * Touch goes through touch events, not pointer events: those keep coming while
 * the browser scrolls a nested container, so no `touch-action` is needed on
 * the page. Mouse drags are not swipes.
 *
 * A gesture that belongs to something under it is left alone: a container that
 * can still scroll that way, or an element that takes its own touch gestures
 * (`touch-action: none` / `pan-x`, a range slider, an element with its own
 * `use:swipe` — marked `data-own-swipe`). Sideways wheel events the
 * element does take are prevented, so the browser's back/forward swipe does
 * not also fire.
 */
export type SideSwipeParams = {
  onswipe: (direction: SwipeDirection) => void
  onprogress?: (dx: number) => void
  oncancel?: () => void
}

/** Which ways something under `target` (up to `root`) would take a sideways gesture. */
type Taken = Record<SwipeDirection, boolean>

function takenUnder(target: EventTarget | null, root: HTMLElement, kind: 'touch' | 'wheel'): Taken {
  const taken: Taken = { left: false, right: false }
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el instanceof HTMLInputElement && el.type === 'range') return { left: true, right: true }
    // `use:swipe` takes touch flicks only; a trackpad scroll over it is still the shell's.
    if (kind === 'touch' && el instanceof HTMLElement && 'ownSwipe' in el.dataset) return { left: true, right: true }
    const style = getComputedStyle(el)
    if (style.touchAction === 'none' || style.touchAction.includes('pan-x')) return { left: true, right: true }
    const scrolls = (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1
    if (!scrolls) continue
    // A swipe right moves the content right: it scrolls back toward the start.
    if (el.scrollLeft > 0) taken.right = true
    if (el.scrollLeft + el.clientWidth < el.scrollWidth - 1) taken.left = true
  }
  return taken
}

/** Wheel deltas in px, whatever unit the device reports them in. */
function px(delta: number, mode: number): number {
  return mode === WheelEvent.DOM_DELTA_LINE ? delta * 16 : mode === WheelEvent.DOM_DELTA_PAGE ? delta * 400 : delta
}

export const sideSwipe: Action<HTMLElement, SideSwipeParams> = (node, initial) => {
  let params = initial

  // Touch.
  const touches = new SwipeTracker()
  let touchTaken: Taken = { left: false, right: false }
  let touchId: number | null = null
  let touchStartX: number | null = null
  let touchProgressActive = false
  const cancelTouchProgress = () => {
    if (!touchProgressActive) return
    touchProgressActive = false
    params.oncancel?.()
  }
  const point = (t: Touch, e: TouchEvent, isPrimary: boolean): SwipePoint => ({
    pointerId: t.identifier,
    pointerType: 'touch',
    isPrimary,
    x: t.clientX,
    y: t.clientY,
    t: e.timeStamp,
  })
  const touchstart = (e: TouchEvent) => {
    const t = e.changedTouches[0]
    if (!t) return
    // A second finger (pinch, two-finger pan) ends the swipe.
    if (e.touches.length > 1) {
      for (const other of e.touches) touches.cancel(other.identifier)
      touchId = null
      touchStartX = null
      cancelTouchProgress()
      return
    }
    touchTaken = takenUnder(e.target, node, 'touch')
    touchId = t.identifier
    touchStartX = t.clientX
    touchProgressActive = false
    touches.down(point(t, e, true))
  }
  const touchmove = (e: TouchEvent) => {
    for (const t of e.changedTouches) {
      const state = touches.move(point(t, e, true))
      if (t.identifier !== touchId || touchStartX === null) continue
      if (state === 'horizontal') {
        const dx = t.clientX - touchStartX
        const heading: SwipeDirection = dx < 0 ? 'left' : 'right'
        if (dx !== 0 && !touchTaken[heading]) {
          touchProgressActive = true
          params.onprogress?.(dx)
        } else {
          cancelTouchProgress()
        }
      } else if (state === 'abandoned') {
        cancelTouchProgress()
      }
    }
  }
  const touchend = (e: TouchEvent) => {
    for (const t of e.changedTouches) {
      const s = touches.up(point(t, e, true))
      const isTracked = t.identifier === touchId
      const wasActive = isTracked && touchProgressActive
      if (isTracked) {
        touchId = null
        touchStartX = null
        touchProgressActive = false
      }
      if (s && !touchTaken[s.direction]) params.onswipe(s.direction)
      else if (wasActive) params.oncancel?.()
    }
  }
  const touchcancel = (e: TouchEvent) => {
    for (const t of e.changedTouches) {
      touches.cancel(t.identifier)
      if (t.identifier === touchId) {
        touchId = null
        touchStartX = null
        cancelTouchProgress()
      }
    }
  }

  // Wheel / trackpad.
  const wheels = new WheelSwipeTracker()
  let wheelTaken: Taken = { left: false, right: false }
  let wheelTimer: ReturnType<typeof setTimeout> | undefined
  let wheelProgressActive = false
  const clearWheelTimer = () => {
    if (wheelTimer !== undefined) {
      clearTimeout(wheelTimer)
      wheelTimer = undefined
    }
  }
  const cancelWheelProgress = () => {
    clearWheelTimer()
    if (!wheelProgressActive) return
    wheelProgressActive = false
    params.oncancel?.()
  }
  const wheel = (e: WheelEvent) => {
    if (e.ctrlKey) return // pinch-zoom on a trackpad
    if (wheels.startsGesture(e.timeStamp)) {
      cancelWheelProgress()
      wheelTaken = takenUnder(e.target, node, 'wheel')
    }
    const direction = wheels.wheel({ deltaX: px(e.deltaX, e.deltaMode), deltaY: px(e.deltaY, e.deltaMode), t: e.timeStamp })
    const sideways = wheels.state === 'horizontal' || wheels.state === 'done'
    if (!sideways) {
      if (wheels.state === 'abandoned') cancelWheelProgress()
      return
    }
    // Heading a way something under the pointer scrolls: that container's gesture, to its end.
    const heading: SwipeDirection =
      e.deltaX !== 0 ? (e.deltaX < 0 ? 'right' : 'left') : wheels.offset > 0 ? 'right' : 'left'
    if (wheelTaken[heading]) {
      if (wheels.state === 'horizontal') wheels.abandon()
      cancelWheelProgress()
      return
    }
    e.preventDefault()
    if (direction) {
      clearWheelTimer()
      wheelProgressActive = false
      params.onswipe(direction)
      return
    }
    if (wheels.state === 'horizontal') {
      wheelProgressActive = true
      params.onprogress?.(wheels.offset)
      clearWheelTimer()
      wheelTimer = setTimeout(() => {
        wheelTimer = undefined
        if (!wheelProgressActive) return
        wheelProgressActive = false
        wheels.reset()
        params.oncancel?.()
      }, wheels.options.gap)
    }
  }

  node.addEventListener('touchstart', touchstart, { passive: true })
  node.addEventListener('touchmove', touchmove, { passive: true })
  node.addEventListener('touchend', touchend, { passive: true })
  node.addEventListener('touchcancel', touchcancel, { passive: true })
  node.addEventListener('wheel', wheel, { passive: false })
  return {
    update(next) {
      params = next
    },
    destroy() {
      clearWheelTimer()
      node.removeEventListener('touchstart', touchstart)
      node.removeEventListener('touchmove', touchmove)
      node.removeEventListener('touchend', touchend)
      node.removeEventListener('touchcancel', touchcancel)
      node.removeEventListener('wheel', wheel)
    },
  }
}
