import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MEDIA,
  MEDIA_KEY,
  audioCaptureOf,
  readMedia,
  saveMedia,
  videoCaptureOf,
} from './media-settings'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  }
}

describe('media settings (a client media preference, remembered per browser)', () => {
  it('defaults to auto video with noise cancellation on', () => {
    expect(readMedia(memoryStorage())).toEqual(DEFAULT_MEDIA)
    expect(DEFAULT_MEDIA).toEqual({ videoQuality: 'auto', noiseCancellation: true })
  })

  it('remembers a change and keeps the other setting', () => {
    const s = memoryStorage()
    saveMedia(s, { videoQuality: 'low' })
    saveMedia(s, { noiseCancellation: false })
    expect(readMedia(s)).toEqual({ videoQuality: 'low', noiseCancellation: false })
    expect(s.data[MEDIA_KEY]).toBeDefined()
  })

  it('reports and ignores a broken stored value', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(readMedia(memoryStorage({ [MEDIA_KEY]: '{"videoQuality":"ultra"}' }))).toEqual(
      DEFAULT_MEDIA,
    )
    expect(readMedia(memoryStorage({ [MEDIA_KEY]: 'nope' }))).toEqual(DEFAULT_MEDIA)
    expect(err).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })

  it('maps video quality to camera capture: auto leaves it to the room, low is 360p, high is 1080p', () => {
    expect(videoCaptureOf('auto')).toEqual({})
    expect(videoCaptureOf('low').resolution).toMatchObject({ width: 640, height: 360 })
    expect(videoCaptureOf('high').resolution).toMatchObject({ width: 1920, height: 1080 })
  })

  it('maps noise cancellation to the three browser audio constraints', () => {
    expect(audioCaptureOf(true)).toEqual({
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    })
    expect(audioCaptureOf(false)).toEqual({
      noiseSuppression: false,
      echoCancellation: false,
      autoGainControl: false,
    })
  })
})
