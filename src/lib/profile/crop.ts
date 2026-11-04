/**
 * Square crop geometry for the profile picture editor: the person pans and
 * zooms a square window over their photo; the window is drawn onto a
 * 256 × 256 canvas and saved as WebP. Pure so it is unit-tested.
 */

export type Crop = {
  /** 1 = the largest square that fits; higher = closer. */
  zoom: number
  /** The window's centre, in image pixels. */
  cx: number
  cy: number
}

export const MAX_ZOOM = 4

export type SourceRect = { sx: number; sy: number; side: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The centred, fully zoomed-out square. */
export function initialCrop(width: number, height: number): Crop {
  if (!(width > 0 && height > 0)) throw new Error(`image has no size (${width}×${height})`)
  return { zoom: 1, cx: width / 2, cy: height / 2 }
}

const sideOf = (width: number, height: number, zoom: number) => Math.min(width, height) / clamp(zoom, 1, MAX_ZOOM)

/** Keeps the window inside the image (zoom within 1…MAX_ZOOM). */
export function clampCrop(width: number, height: number, crop: Crop): Crop {
  const zoom = clamp(crop.zoom, 1, MAX_ZOOM)
  const half = sideOf(width, height, zoom) / 2
  return { zoom, cx: clamp(crop.cx, half, width - half), cy: clamp(crop.cy, half, height - half) }
}

/** The source square to draw (image pixels). */
export function sourceRect(width: number, height: number, crop: Crop): SourceRect {
  const c = clampCrop(width, height, crop)
  const side = sideOf(width, height, c.zoom)
  return { sx: c.cx - side / 2, sy: c.cy - side / 2, side }
}

/**
 * Drag in the on-screen preview (viewSize px square): the photo follows the
 * pointer, so the window moves the other way.
 */
export function panBy(width: number, height: number, crop: Crop, dx: number, dy: number, viewSize: number): Crop {
  const scale = sideOf(width, height, crop.zoom) / viewSize
  return clampCrop(width, height, { ...crop, cx: crop.cx - dx * scale, cy: crop.cy - dy * scale })
}

export function zoomTo(width: number, height: number, crop: Crop, zoom: number): Crop {
  return clampCrop(width, height, { ...crop, zoom })
}
