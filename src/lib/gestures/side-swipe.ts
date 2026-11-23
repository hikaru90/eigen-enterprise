import type { SwipeDirection } from './swipe'

/**
 * Opening the shell's side panels by scrolling sideways (owner, 2026-11-23):
 * a horizontal flick on touch, a horizontal trackpad scroll (or Shift+wheel)
 * on desktop. Pure, no DOM: the `sideSwipe` action (side-swipe-action.ts)
 * feeds it.
 *
 * A gesture is named like a touch swipe — by where the fingers went — so a
 * swipe `right` pulls the left side in and a swipe `left` pulls the right
 * side in. Two fingers moving right on a trackpad scroll toward the left
 * (deltaX < 0): that is a swipe `right` too.
 */

export type WheelPoint = { deltaX: number; deltaY: number; t: number }

export type WheelSwipeOptions = {
  /** Sideways scroll (px) one gesture needs before it counts. */
  minDistance: number
  /** The first `slop` px decide the axis; a vertical start is abandoned for good. */
  slop: number
  /** A pause this long (ms) between wheel events ends the gesture (momentum included). */
  gap: number
}

export const WHEEL_SWIPE_DEFAULTS: WheelSwipeOptions = { minDistance: 80, slop: 10, gap: 220 }

export type WheelSwipeState = 'idle' | 'pending' | 'horizontal' | 'abandoned' | 'done'

/**
 * A stream of wheel events → at most one swipe per gesture. A trackpad
 * gesture is one burst of wheel events (its momentum included); the burst
 * fires once and then stays quiet until the next one, so a long flick does
 * not open and then close a panel.
 */
export class WheelSwipeTracker {
  readonly options: WheelSwipeOptions
  #state: WheelSwipeState = 'idle'
  #last = -Infinity
  #dx = 0
  #dy = 0

  constructor(options: Partial<WheelSwipeOptions> = {}) {
    this.options = { ...WHEEL_SWIPE_DEFAULTS, ...options }
  }

  get state(): WheelSwipeState {
    return this.#state
  }

  /** True when this event starts a new gesture (the caller looks at what is under it then). */
  startsGesture(t: number): boolean {
    return this.#state === 'idle' || t - this.#last > this.options.gap
  }

  /** One wheel event: the swipe it completes, or null. */
  wheel(p: WheelPoint): SwipeDirection | null {
    if (this.startsGesture(p.t)) {
      this.#state = 'pending'
      this.#dx = 0
      this.#dy = 0
    }
    this.#last = p.t
    if (this.#state === 'abandoned' || this.#state === 'done') return null
    this.#dx += p.deltaX
    this.#dy += p.deltaY
    if (this.#state === 'pending') {
      const ax = Math.abs(this.#dx)
      const ay = Math.abs(this.#dy)
      if (Math.max(ax, ay) < this.options.slop) return null
      this.#state = ax > ay ? 'horizontal' : 'abandoned'
      if (this.#state === 'abandoned') return null
    }
    if (Math.abs(this.#dx) < this.options.minDistance) return null
    this.#state = 'done'
    return this.#dx < 0 ? 'right' : 'left'
  }

  /** The gesture is not ours (it scrolls something sideways): ignore it to its end. */
  abandon(): void {
    this.#state = 'abandoned'
  }
}

/** What the shell's panels look like when a swipe lands. */
export type SidePanels = {
  /** The left side is showing: the phone drawer is open, or the desktop sidebar is expanded. */
  leftShown: boolean
  /** The left side covers the page (the phone drawer), so it can be swiped away. */
  leftOverlays: boolean
  /** The right side (the assistant panel) is open. */
  rightShown: boolean
  /** There is a right side at all (the Assistant plugin is on). */
  hasRight: boolean
}

export type SideMove = 'open-left' | 'close-left' | 'open-right' | 'close-right'

/**
 * The page sits between the two sides: swiping right first puts away the
 * right side, then pulls in the left; swiping left first puts away the
 * overlaid left side (the phone drawer), then pulls in the right. The
 * docked desktop sidebar is never swiped away — it does not cover anything.
 */
export function sideMove(direction: SwipeDirection, panels: SidePanels): SideMove | null {
  if (direction === 'right') {
    if (panels.rightShown) return 'close-right'
    return panels.leftShown ? null : 'open-left'
  }
  if (panels.leftShown && panels.leftOverlays) return 'close-left'
  return panels.hasRight && !panels.rightShown ? 'open-right' : null
}
