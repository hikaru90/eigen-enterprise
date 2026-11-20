import type { Box, XfrmPatch } from './ops'
import { EMU_PER_PX } from './resolve'

/**
 * Selection geometry for the slide editor: a shape's box on the slide in CSS
 * pixels (the slide's viewBox units) and degrees, and how dragging a resize
 * or rotate handle changes it. Pure functions; EMU only at the edges
 * (`frameOf`, `boxOf`, `patchOf`).
 */

export type EditFrame = { x: number; y: number; w: number; h: number; rot: number }

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** Each handle's side on the box: -1 left/top, 0 middle, 1 right/bottom. */
export const HANDLES: Record<Handle, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
}

const rad = (deg: number) => (deg * Math.PI) / 180
const norm = (deg: number) => ((deg % 360) + 360) % 360

/** A model box (EMU, degrees) as an editor frame. */
export function frameOf(x: { x: number; y: number; cx: number; cy: number; rot: number }): EditFrame {
  return { x: x.x / EMU_PER_PX, y: x.y / EMU_PER_PX, w: x.cx / EMU_PER_PX, h: x.cy / EMU_PER_PX, rot: norm(x.rot) }
}

export function boxOf(f: EditFrame): Box {
  return { x: Math.round(f.x * EMU_PER_PX), y: Math.round(f.y * EMU_PER_PX), cx: Math.round(f.w * EMU_PER_PX), cy: Math.round(f.h * EMU_PER_PX) }
}

/** What changed between two frames, as an xfrm patch in EMU (unchanged fields left out). */
export function patchOf(from: EditFrame, to: EditFrame): XfrmPatch {
  const a = boxOf(from)
  const b = boxOf(to)
  const out: XfrmPatch = {}
  if (a.x !== b.x) out.x = b.x
  if (a.y !== b.y) out.y = b.y
  if (a.cx !== b.cx) out.cx = b.cx
  if (a.cy !== b.cy) out.cy = b.cy
  if (Math.abs(norm(from.rot) - norm(to.rot)) > 1e-6) out.rot = norm(to.rot)
  return out
}

export function moveFrame(f: EditFrame, dx: number, dy: number): EditFrame {
  return { ...f, x: f.x + dx, y: f.y + dy }
}

/**
 * Drags `handle` by (dx, dy) on the slide: the opposite side (or corner)
 * stays where it is, also on a rotated shape. `keepAspect` (Shift) scales a
 * corner drag evenly. Sizes never go below `min`.
 */
export function resizeFrame(f: EditFrame, handle: Handle, dx: number, dy: number, keepAspect: boolean, min = 1): EditFrame {
  const [hx, hy] = HANDLES[handle]
  const c = Math.cos(rad(f.rot))
  const s = Math.sin(rad(f.rot))
  // The drag in the shape's own (unrotated) axes.
  const lx = dx * c + dy * s
  const ly = -dx * s + dy * c
  let w = hx ? Math.max(min, f.w + hx * lx) : f.w
  let h = hy ? Math.max(min, f.h + hy * ly) : f.h
  if (keepAspect && hx && hy && f.w > 0 && f.h > 0) {
    const k = Math.max(w / f.w, h / f.h)
    w = Math.max(min, f.w * k)
    h = Math.max(min, f.h * k)
  }
  // Keep the anchor (opposite handle) fixed: the centre moves by R·(new half-size − old half-size) along the handle's sides.
  const ax = (hx * (w - f.w)) / 2
  const ay = (hy * (h - f.h)) / 2
  const cx = f.x + f.w / 2 + ax * c - ay * s
  const cy = f.y + f.h / 2 + ax * s + ay * c
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot: f.rot }
}

/** The rotation that points the rotate handle (above the top edge) at (px, py); `snap` (Shift) in 15° steps. */
export function rotationTo(f: EditFrame, px: number, py: number, snap: boolean): number {
  const cx = f.x + f.w / 2
  const cy = f.y + f.h / 2
  let deg = norm((Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90)
  if (snap) deg = norm(Math.round(deg / 15) * 15)
  return Math.round(deg * 100) / 100
}
