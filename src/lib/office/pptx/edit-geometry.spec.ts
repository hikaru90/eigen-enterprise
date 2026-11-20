import { describe, expect, it } from 'vitest'
import { boxOf, frameOf, moveFrame, patchOf, resizeFrame, rotationTo, type EditFrame } from './edit-geometry'

const F: EditFrame = { x: 100, y: 100, w: 200, h: 100, rot: 0 }
const close = (f: EditFrame, want: Partial<EditFrame>) => {
  for (const [k, v] of Object.entries(want)) expect(f[k as keyof EditFrame], k).toBeCloseTo(v as number, 6)
}

describe('edit geometry', () => {
  it('converts between EMU boxes and pixel frames', () => {
    const f = frameOf({ x: 952500, y: 9525, cx: 1905000, cy: 95250, rot: -90 })
    expect(f).toEqual({ x: 100, y: 1, w: 200, h: 10, rot: 270 })
    expect(boxOf(f)).toEqual({ x: 952500, y: 9525, cx: 1905000, cy: 95250 })
  })

  it('patches only what changed', () => {
    expect(patchOf(F, moveFrame(F, 10, 0))).toEqual({ x: (100 + 10) * 9525 })
    expect(patchOf(F, { ...F, rot: 360 })).toEqual({})
    expect(patchOf(F, { ...F, rot: 45 })).toEqual({ rot: 45 })
  })

  it('resizes from a corner and an edge, the opposite side staying put', () => {
    close(resizeFrame(F, 'se', 20, 10, false), { x: 100, y: 100, w: 220, h: 110 })
    close(resizeFrame(F, 'nw', 20, 10, false), { x: 120, y: 110, w: 180, h: 90 })
    close(resizeFrame(F, 'e', 50, 999, false), { x: 100, y: 100, w: 250, h: 100 })
    close(resizeFrame(F, 'n', 0, -30, false), { x: 100, y: 70, w: 200, h: 130 })
  })

  it('keeps the aspect ratio on corner drags with Shift and never goes below the minimum', () => {
    close(resizeFrame(F, 'se', 200, 0, true), { w: 400, h: 200, x: 100, y: 100 })
    close(resizeFrame(F, 'e', -500, 0, false, 1), { w: 1, x: 100 })
  })

  it('resizes a rotated shape in its own axes and keeps the opposite edge fixed on the slide', () => {
    const r: EditFrame = { ...F, rot: 90 }
    // rotated 90°: the shape's own +x axis points down the slide
    const out = resizeFrame(r, 'e', 0, 40, false)
    close(out, { w: 240, h: 100 })
    // the w-edge midpoint (the anchor) stays where it was on the slide
    const anchor = (f: EditFrame) => {
      const cx = f.x + f.w / 2
      const cy = f.y + f.h / 2
      const a = (f.rot * Math.PI) / 180
      return [cx - (f.w / 2) * Math.cos(a), cy - (f.w / 2) * Math.sin(a)]
    }
    expect(anchor(out)[0]).toBeCloseTo(anchor(r)[0]!, 6)
    expect(anchor(out)[1]).toBeCloseTo(anchor(r)[1]!, 6)
  })

  it('rotates towards the pointer, snapping to 15° with Shift', () => {
    // centre (200, 150): straight up is 0°, right is 90°
    expect(rotationTo(F, 200, 0, false)).toBe(0)
    expect(rotationTo(F, 400, 150, false)).toBe(90)
    expect(rotationTo(F, 200, 400, false)).toBe(180)
    expect(rotationTo(F, 300, 40, true)).toBe(45)
  })
})
