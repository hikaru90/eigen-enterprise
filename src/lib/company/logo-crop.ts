/**
 * Cropping the company logo (Contribute `8c371cea`): the person zooms and
 * moves the uploaded image inside a square frame; the crop is that frame in
 * the image's own pixels — a square that may reach past the image's edges
 * when it is zoomed out (that part stays transparent). The settings page
 * works with a view (scale and where the image's top-left corner sits in the
 * frame); the server gets the crop, checks it, and cuts the stored logo from
 * the kept original, so the crop can be changed again later.
 */

/** The smallest crop, in image pixels (the server refuses a logo smaller than this, too). */
export const MIN_CROP_PX = 16

export type ImageSize = { width: number; height: number }
/** The frame in image pixels: a square `size` wide whose top-left corner is at (left, top). */
export type LogoCrop = { left: number; top: number; size: number }
/** Display pixels per image pixel, and the image's top-left corner in frame pixels. */
export type CropView = { scale: number; x: number; y: number }

/** -0 shows up as "-0" in places; a crop never needs it. */
const noNegZero = (n: number) => n + 0

/** From the whole image in the frame to a crop MIN_CROP_PX wide (never less than covering the frame). */
export function scaleRange(img: ImageSize, frame: number): { min: number; max: number } {
  const min = frame / Math.max(img.width, img.height)
  return { min, max: Math.max(frame / MIN_CROP_PX, frame / Math.min(img.width, img.height)) }
}

function clampAxis(offset: number, shown: number, frame: number): number {
  // Larger than the frame: it always covers it. Smaller: it stays inside it.
  const [lo, hi] = shown >= frame ? [frame - shown, 0] : [0, frame - shown]
  return noNegZero(Math.min(hi, Math.max(lo, offset)))
}

/** The view kept within its scale range, with the image covering (or inside) the frame on each axis. */
export function clampView(view: CropView, img: ImageSize, frame: number): CropView {
  const { min, max } = scaleRange(img, frame)
  const scale = Math.min(max, Math.max(min, view.scale))
  return {
    scale,
    x: clampAxis(view.x, img.width * scale, frame),
    y: clampAxis(view.y, img.height * scale, frame),
  }
}

/** The whole image, centred: where cropping starts. */
export function fitView(img: ImageSize, frame: number): CropView {
  const scale = scaleRange(img, frame).min
  return {
    scale,
    x: noNegZero((frame - img.width * scale) / 2),
    y: noNegZero((frame - img.height * scale) / 2),
  }
}

/** Zoom to `scale`, keeping the image point under `at` (frame pixels) where it is. */
export function zoomAround(view: CropView, scale: number, at: { x: number; y: number }, img: ImageSize, frame: number): CropView {
  const { min, max } = scaleRange(img, frame)
  const next = Math.min(max, Math.max(min, scale))
  const sx = (at.x - view.x) / view.scale
  const sy = (at.y - view.y) / view.scale
  return clampView({ scale: next, x: at.x - sx * next, y: at.y - sy * next }, img, frame)
}

/** The frame in image pixels. */
export function cropOf(view: CropView, frame: number): LogoCrop {
  return { left: noNegZero(-view.x / view.scale), top: noNegZero(-view.y / view.scale), size: frame / view.scale }
}

/** The view a stored crop was made in (re-cropping starts there). */
export function viewOf(crop: LogoCrop, img: ImageSize, frame: number): CropView {
  const scale = frame / crop.size
  return clampView({ scale, x: -crop.left * scale, y: -crop.top * scale }, img, frame)
}

export type LogoCropCheck = { ok: true; crop: LogoCrop } | { ok: false; error: string }

/** Slack for floating point: a crop of the whole image computed in the browser may be a hair over. */
const EPSILON = 1e-6

/** What the server accepts as a crop of an image this size; every refusal says why. */
export function checkLogoCrop(raw: unknown, img: ImageSize): LogoCropCheck {
  const refuse = (error: string): LogoCropCheck => ({ ok: false, error })
  if (typeof raw !== 'object' || raw === null) return refuse('The crop is missing.')
  const { left, top, size } = raw as Record<string, unknown>
  if (![left, top, size].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return refuse('The crop must be three numbers: left, top and size.')
  }
  const c = { left: left as number, top: top as number, size: size as number }
  if (c.size < MIN_CROP_PX) return refuse(`The crop is too small (at least ${MIN_CROP_PX} pixels of the image).`)
  if (c.size > Math.max(img.width, img.height) + EPSILON) return refuse('The crop is larger than the whole image.')
  if (c.left >= img.width || c.top >= img.height || c.left + c.size <= 0 || c.top + c.size <= 0) {
    return refuse('The crop does not show any of the image.')
  }
  return { ok: true, crop: c }
}
