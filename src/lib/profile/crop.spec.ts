import { describe, expect, it } from 'vitest'
import { clampCrop, initialCrop, MAX_ZOOM, panBy, sourceRect, zoomTo } from './crop'

describe('profile picture crop', () => {
  it('starts with the largest centred square', () => {
    expect(sourceRect(400, 200, initialCrop(400, 200))).toEqual({ sx: 100, sy: 0, side: 200 })
    expect(sourceRect(300, 600, initialCrop(300, 600))).toEqual({ sx: 0, sy: 150, side: 300 })
  })

  it('refuses an image without a size', () => {
    expect(() => initialCrop(0, 100)).toThrow()
  })

  it('zooms in around the centre and caps the zoom', () => {
    const c = zoomTo(400, 200, initialCrop(400, 200), 2)
    expect(sourceRect(400, 200, c)).toEqual({ sx: 150, sy: 50, side: 100 })
    expect(zoomTo(400, 200, c, 99).zoom).toBe(MAX_ZOOM)
    expect(zoomTo(400, 200, c, 0.2).zoom).toBe(1)
  })

  it('pans opposite to the drag, scaled from the preview to image pixels, never past the edges', () => {
    // Window 200px of image shown in a 100px preview: 1 preview px = 2 image px.
    const start = initialCrop(400, 200)
    const moved = panBy(400, 200, start, 10, 0, 100) // drag right → see more of the left
    expect(moved.cx).toBe(180)
    expect(panBy(400, 200, start, 1000, 0, 100).cx).toBe(100) // clamped at the left edge
    expect(panBy(400, 200, start, 0, 50, 100).cy).toBe(100) // the square already fills the height
  })

  it('clamps a window that zoomed out past an edge back inside', () => {
    expect(clampCrop(400, 200, { zoom: 1, cx: 390, cy: 100 })).toEqual({ zoom: 1, cx: 300, cy: 100 })
  })
})
