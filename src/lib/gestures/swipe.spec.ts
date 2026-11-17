import { describe, expect, it } from 'vitest'
import { SwipeTracker } from './swipe'

const touch = (x: number, y: number, t: number, id = 1) => ({ pointerId: id, pointerType: 'touch', isPrimary: true, x, y, t })

/** A gesture from its points: the first is the touch-down, the last the lift. */
function gesture(tracker: SwipeTracker, points: [number, number, number][]) {
  const [first, ...rest] = points
  tracker.down(touch(...first))
  for (const p of rest.slice(0, -1)) tracker.move(touch(...p))
  return tracker.up(touch(...rest.at(-1)!))
}

describe('SwipeTracker', () => {
  it('a quick horizontal flick is a swipe, named by where the finger went', () => {
    expect(gesture(new SwipeTracker(), [[200, 300, 0], [150, 305, 80], [100, 308, 160]])).toEqual({ direction: 'left', startX: 200, startY: 300, distance: 100 })
    expect(gesture(new SwipeTracker(), [[10, 300, 0], [60, 296, 80], [120, 292, 160]])).toMatchObject({ direction: 'right', startX: 10 })
  })

  it('too short, too slow or too slanted is no swipe', () => {
    expect(gesture(new SwipeTracker(), [[200, 300, 0], [160, 300, 100]])).toBeNull()
    expect(gesture(new SwipeTracker(), [[200, 300, 0], [150, 300, 500], [100, 300, 1200]])).toBeNull()
    expect(gesture(new SwipeTracker(), [[200, 300, 0], [140, 340, 100], [100, 360, 160]])).toBeNull()
  })

  it('leaves vertical scrolling alone: once the finger heads up or down, the gesture is not a swipe', () => {
    const t = new SwipeTracker()
    t.down(touch(200, 300, 0))
    expect(t.move(touch(198, 280, 40))).toBe('abandoned')
    // Turning sideways afterwards does not bring it back.
    t.move(touch(100, 280, 120))
    expect(t.up(touch(80, 280, 160))).toBeNull()
  })

  it('a horizontal start is tracked (the caller may then keep the page from scrolling)', () => {
    const t = new SwipeTracker()
    t.down(touch(200, 300, 0))
    expect(t.move(touch(195, 300, 10))).toBe('pending')
    expect(t.move(touch(180, 302, 30))).toBe('horizontal')
  })

  it('only touch and pen, only the first finger; a cancelled gesture is dropped', () => {
    const mouse = new SwipeTracker()
    mouse.down({ ...touch(200, 300, 0), pointerType: 'mouse' })
    expect(mouse.up(touch(50, 300, 100))).toBeNull()

    const two = new SwipeTracker()
    two.down(touch(200, 300, 0))
    two.down({ ...touch(220, 300, 10, 2), isPrimary: false })
    expect(two.up(touch(80, 300, 100, 2))).toBeNull()
    expect(two.up(touch(80, 300, 120))).toMatchObject({ direction: 'left' })

    const cancelled = new SwipeTracker()
    cancelled.down(touch(200, 300, 0))
    cancelled.cancel(1)
    expect(cancelled.up(touch(50, 300, 100))).toBeNull()
  })

  it('thresholds can be set per use', () => {
    const strict = new SwipeTracker({ minDistance: 150 })
    expect(gesture(strict, [[200, 300, 0], [100, 300, 100]])).toBeNull()
  })
})
