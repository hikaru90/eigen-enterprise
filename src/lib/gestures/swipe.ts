/**
 * Horizontal swipes on touch screens (Contribute b6625f4c), from touch or pointer points —
 * pure, no DOM: the `swipe` action (swipe-action.ts) and the shell's `sideSwipe` (side-swipe-action.ts) feed it.
 *
 * A swipe is a quick, mostly horizontal flick of one finger (or pen): at least
 * `minDistance` px sideways, at most `maxSlope` px up or down per px sideways,
 * within `maxDuration` ms. Vertical scrolling is never taken over: the first
 * `slop` px of movement decide the axis, and a gesture that starts vertically is
 * abandoned for good. Mouse pointers are ignored (desktop has buttons).
 */

export type SwipeDirection = 'left' | 'right'
export type Swipe = { direction: SwipeDirection; startX: number; startY: number; distance: number }

export type SwipePoint = { pointerId: number; pointerType: string; isPrimary: boolean; x: number; y: number; t: number }

export type SwipeOptions = { minDistance: number; maxSlope: number; maxDuration: number; slop: number }

export const SWIPE_DEFAULTS: SwipeOptions = { minDistance: 60, maxSlope: 0.5, maxDuration: 800, slop: 10 }

/** What the gesture is so far: `pending` until it moved `slop` px, then its axis. */
export type SwipeState = 'idle' | 'pending' | 'horizontal' | 'abandoned'

export class SwipeTracker {
  readonly options: SwipeOptions
  #start: SwipePoint | null = null
  #state: SwipeState = 'idle'

  constructor(options: Partial<SwipeOptions> = {}) {
    this.options = { ...SWIPE_DEFAULTS, ...options }
  }

  down(p: SwipePoint): void {
    if (!p.isPrimary || (p.pointerType !== 'touch' && p.pointerType !== 'pen')) return
    this.#start = p
    this.#state = 'pending'
  }

  move(p: SwipePoint): SwipeState {
    const s = this.#start
    if (!s || p.pointerId !== s.pointerId || this.#state !== 'pending') return this.#state
    const dx = Math.abs(p.x - s.x)
    const dy = Math.abs(p.y - s.y)
    if (Math.max(dx, dy) < this.options.slop) return this.#state
    this.#state = dx > dy ? 'horizontal' : 'abandoned'
    return this.#state
  }

  /** The finger lifted: the swipe it made, or null. */
  up(p: SwipePoint): Swipe | null {
    const s = this.#start
    if (!s || p.pointerId !== s.pointerId) return null
    const state = this.#state
    this.#reset()
    if (state === 'abandoned') return null
    const dx = p.x - s.x
    const dy = Math.abs(p.y - s.y)
    const { minDistance, maxSlope, maxDuration } = this.options
    if (Math.abs(dx) < minDistance || dy > Math.abs(dx) * maxSlope || p.t - s.t > maxDuration) return null
    return { direction: dx < 0 ? 'left' : 'right', startX: s.x, startY: s.y, distance: Math.abs(dx) }
  }

  cancel(pointerId: number): void {
    if (this.#start?.pointerId === pointerId) this.#reset()
  }

  #reset(): void {
    this.#start = null
    this.#state = 'idle'
  }
}
