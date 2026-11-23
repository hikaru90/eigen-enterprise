import { describe, expect, it } from 'vitest'
import { sideMove, type SidePanels, WheelSwipeTracker } from './side-swipe'

/** Wheel events 16 ms apart, starting at t0. */
function burst(tracker: WheelSwipeTracker, deltas: [number, number][], t0 = 0) {
  return deltas.map(([deltaX, deltaY], i) => tracker.wheel({ deltaX, deltaY, t: t0 + i * 16 }))
}

describe('WheelSwipeTracker', () => {
  it('a sideways trackpad scroll is one swipe, named by where the fingers went', () => {
    // Fingers move right → the page scrolls toward the left (deltaX < 0) → swipe right.
    expect(burst(new WheelSwipeTracker(), [[-30, 2], [-30, 1], [-30, 0]])).toEqual([null, null, 'right'])
    expect(burst(new WheelSwipeTracker(), [[40, 0], [45, 3]])).toEqual([null, 'left'])
  })

  it('fires once per gesture: momentum after the swipe stays quiet', () => {
    const t = new WheelSwipeTracker()
    expect(burst(t, [[-50, 0], [-50, 0], [-50, 0], [-50, 0], [-50, 0]]).filter(Boolean)).toEqual(['right'])
    // Momentum heading back the other way, still the same burst: nothing.
    expect(burst(t, [[90, 0], [90, 0]], 5 * 16)).toEqual([null, null])
    // After a pause, a new gesture.
    expect(burst(t, [[90, 0]], 5 * 16 + 32 + 500)).toEqual(['left'])
  })

  it('leaves vertical scrolling alone: a gesture that starts vertically never becomes a swipe', () => {
    const t = new WheelSwipeTracker()
    expect(burst(t, [[1, 12], [-60, 0], [-60, 0], [-60, 0]])).toEqual([null, null, null, null])
    expect(t.state).toBe('abandoned')
  })

  it('too little sideways scroll is no swipe', () => {
    expect(burst(new WheelSwipeTracker(), [[-20, 0], [-20, 0], [-20, 0]])).toEqual([null, null, null])
  })

  it('an abandoned gesture (it scrolls something sideways) stays ignored to its end', () => {
    const t = new WheelSwipeTracker()
    expect(t.startsGesture(0)).toBe(true)
    t.wheel({ deltaX: -5, deltaY: 0, t: 0 })
    t.abandon()
    expect(burst(t, [[-60, 0], [-60, 0]], 16)).toEqual([null, null])
    expect(t.startsGesture(48)).toBe(false)
    expect(t.startsGesture(48 + 500)).toBe(true)
  })
})

describe('sideMove', () => {
  const phone: SidePanels = { leftShown: false, leftOverlays: true, rightShown: false, hasRight: true }
  const desktop: SidePanels = { leftShown: true, leftOverlays: false, rightShown: false, hasRight: true }

  it('swiping right pulls in the left side, swiping left the right side', () => {
    expect(sideMove('right', phone)).toBe('open-left')
    expect(sideMove('left', phone)).toBe('open-right')
    expect(sideMove('left', desktop)).toBe('open-right')
    expect(sideMove('right', { ...desktop, leftShown: false })).toBe('open-left')
  })

  it('a swipe toward an open side puts it away first', () => {
    expect(sideMove('right', { ...phone, rightShown: true })).toBe('close-right')
    expect(sideMove('right', { ...desktop, rightShown: true })).toBe('close-right')
    expect(sideMove('left', { ...phone, leftShown: true })).toBe('close-left')
  })

  it('the docked desktop sidebar is never swiped away, and nothing opens twice', () => {
    expect(sideMove('right', desktop)).toBeNull()
    expect(sideMove('left', { ...desktop, rightShown: true })).toBeNull()
    expect(sideMove('right', { ...phone, leftShown: true })).toBeNull()
  })

  it('with the Assistant off there is no right side to pull in', () => {
    expect(sideMove('left', { ...phone, hasRight: false })).toBeNull()
    expect(sideMove('left', { ...desktop, hasRight: false })).toBeNull()
  })
})
