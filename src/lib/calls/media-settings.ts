/**
 * Video quality and noise cancellation for calls: a per-browser media
 * preference (like the chosen devices, devices.ts), not company data — so it
 * lives in localStorage (`ee.calls.media`) and needs no registry tool.
 * Pure helpers; the room applies them (livekit-room.ts applyMedia).
 */

export type VideoQuality = 'auto' | 'high' | 'low'
export const VIDEO_QUALITIES: readonly VideoQuality[] = ['auto', 'high', 'low']
export type MediaSettings = { videoQuality: VideoQuality; noiseCancellation: boolean }
export type MediaStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const MEDIA_KEY = 'ee.calls.media'
export const DEFAULT_MEDIA: MediaSettings = { videoQuality: 'auto', noiseCancellation: true }

export const VIDEO_QUALITY_LABEL: Record<VideoQuality, string> = {
  auto: 'Auto',
  high: 'High (720p and up)',
  low: 'Low (data saver, 360p)',
}

/** The choice this browser remembers; a broken stored value is reported and ignored. */
export function readMedia(storage: MediaStorage): MediaSettings {
  const raw = storage.getItem(MEDIA_KEY)
  if (raw === null) return { ...DEFAULT_MEDIA }
  try {
    const p = JSON.parse(raw) as Partial<MediaSettings> | null
    if (!p || typeof p !== 'object') throw new Error('not an object')
    if (!VIDEO_QUALITIES.includes(p.videoQuality as VideoQuality))
      throw new Error('bad videoQuality')
    if (typeof p.noiseCancellation !== 'boolean') throw new Error('bad noiseCancellation')
    return { videoQuality: p.videoQuality as VideoQuality, noiseCancellation: p.noiseCancellation }
  } catch (err) {
    console.error(
      `[calls] the remembered media settings (${MEDIA_KEY}) are unreadable; choose them again`,
      err,
    )
    return { ...DEFAULT_MEDIA }
  }
}

export function saveMedia(storage: MediaStorage, patch: Partial<MediaSettings>): MediaSettings {
  const next = { ...readMedia(storage), ...patch }
  storage.setItem(MEDIA_KEY, JSON.stringify(next))
  return next
}

type Resolution = { width: number; height: number; frameRate: number }

/** Camera capture for a quality. Auto adds nothing: the room's own default and adaptive stream decide. */
export function videoCaptureOf(q: VideoQuality): { resolution?: Resolution } {
  if (q === 'high') return { resolution: { width: 1920, height: 1080, frameRate: 30 } }
  if (q === 'low') return { resolution: { width: 640, height: 360, frameRate: 15 } }
  return {}
}

/** Microphone capture: the browser's noise suppression, echo cancellation and auto gain, all together. */
export function audioCaptureOf(on: boolean) {
  return { noiseSuppression: on, echoCancellation: on, autoGainControl: on }
}
