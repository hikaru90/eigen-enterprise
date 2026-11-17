import { describe, expect, it } from 'vitest'
import {
  checkLogoCrop,
  clampView,
  cropOf,
  fitView,
  MIN_CROP_PX,
  scaleRange,
  viewOf,
  zoomAround,
  type CropView,
} from './logo-crop'

const FRAME = 200

describe('logo crop: the view in the frame', () => {
  it('starts with the whole image fitted and centred', () => {
    // 400×200: fits at half size, 200×100, centred vertically.
    expect(fitView({ width: 400, height: 200 }, FRAME)).toEqual({ scale: 0.5, x: 0, y: 50 })
  })

  it('zooms between the whole image and a crop of MIN_CROP_PX source pixels', () => {
    expect(scaleRange({ width: 400, height: 200 }, FRAME)).toEqual({ min: 0.5, max: FRAME / MIN_CROP_PX })
  })

  it('a dimension larger than the frame always covers it; a smaller one stays inside it', () => {
    const img = { width: 400, height: 200 }
    // At scale 1 the image is 400×200: x must keep the frame covered, y keeps it inside.
    expect(clampView({ scale: 1, x: 50, y: -20 }, img, FRAME)).toEqual({ scale: 1, x: 0, y: 0 })
    expect(clampView({ scale: 1, x: -500, y: 5 }, img, FRAME)).toEqual({ scale: 1, x: -200, y: 0 })
    expect(clampView({ scale: 0.5, x: 0, y: 120 }, img, FRAME)).toEqual({ scale: 0.5, x: 0, y: 100 })
  })

  it('clamps the scale to its range', () => {
    const img = { width: 400, height: 200 }
    expect(clampView({ scale: 0.1, x: 0, y: 0 }, img, FRAME).scale).toBe(0.5)
    expect(clampView({ scale: 1000, x: 0, y: 0 }, img, FRAME).scale).toBe(FRAME / MIN_CROP_PX)
  })

  it('zooming keeps the point under the cursor in place', () => {
    const img = { width: 400, height: 400 }
    const start: CropView = { scale: 1, x: -100, y: -100 }
    // The source pixel under (50, 50) is (150, 150); after zooming to 2 it is still under (50, 50).
    const z = zoomAround(start, 2, { x: 50, y: 50 }, img, FRAME)
    expect(z).toEqual({ scale: 2, x: -250, y: -250 })
  })

  it('the crop is the frame in source pixels', () => {
    expect(cropOf({ scale: 0.5, x: 0, y: 50 }, FRAME)).toEqual({ left: 0, top: -100, size: 400 })
    expect(cropOf({ scale: 2, x: -250, y: -250 }, FRAME)).toEqual({ left: 125, top: 125, size: 100 })
  })

  it('a stored crop comes back as the view it was made in', () => {
    const img = { width: 400, height: 400 }
    expect(viewOf({ left: 125, top: 125, size: 100 }, img, FRAME)).toEqual({ scale: 2, x: -250, y: -250 })
  })
})

describe('logo crop: what the server accepts', () => {
  const img = { width: 400, height: 200 }

  it('accepts a square within reach of the image', () => {
    expect(checkLogoCrop({ left: 0, top: -100, size: 400 }, img)).toEqual({ ok: true, crop: { left: 0, top: -100, size: 400 } })
    expect(checkLogoCrop({ left: 10.5, top: 20.25, size: 100 }, img)).toEqual({ ok: true, crop: { left: 10.5, top: 20.25, size: 100 } })
  })

  it('refuses anything that is not three finite numbers', () => {
    for (const bad of [null, 'x', {}, { left: 0, top: 0 }, { left: 0, top: 0, size: Number.NaN }, { left: '0', top: 0, size: 100 }]) {
      expect(checkLogoCrop(bad, img).ok).toBe(false)
    }
  })

  it('refuses a crop smaller than MIN_CROP_PX or larger than the whole image fitted', () => {
    expect(checkLogoCrop({ left: 0, top: 0, size: MIN_CROP_PX - 1 }, img)).toMatchObject({ ok: false })
    expect(checkLogoCrop({ left: 0, top: -150, size: 500 }, img)).toMatchObject({ ok: false })
  })

  it('refuses a crop that misses the image', () => {
    expect(checkLogoCrop({ left: 400, top: 0, size: 100 }, img)).toMatchObject({ ok: false })
    expect(checkLogoCrop({ left: -100, top: 0, size: 100 }, img)).toMatchObject({ ok: false })
  })
})
