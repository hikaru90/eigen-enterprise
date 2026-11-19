import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import VoicePlayer from './voice-player.svelte'

/**
 * The voice message's player: a compact play/pause with progress and time above the
 * transcript. Plays a real (generated) recording in the real browser.
 */

/** A mono 16-bit PCM WAV of `seconds` of a quiet tone, as a blob URL. */
function wavUrl(seconds: number): string {
  const rate = 8000
  const n = Math.round(rate * seconds)
  const buffer = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buffer)
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(800 * Math.sin(i / 4)), true)
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

const urls: string[] = []
const clip = (seconds: number) => {
  const url = wavUrl(seconds)
  urls.push(url)
  return url
}

afterEach(() => {
  for (const url of urls.splice(0)) URL.revokeObjectURL(url)
})

describe('voice-player.svelte', () => {
  it('shows play and the recording’s length, and loads nothing before it is played', async () => {
    render(VoicePlayer, { src: clip(1), durationMs: 4_200 })
    const play = page.getByTestId('voice-player-toggle')
    await expect.element(play).toHaveAccessibleName('Play voice message')
    await expect.element(page.getByTestId('voice-player-time')).toHaveTextContent('0:04')
    await expect.element(page.getByTestId('voice-player')).toHaveAttribute('data-state', 'idle')
    const audio = page.getByTestId('voice-player-audio').element() as HTMLAudioElement
    expect(audio.preload).toBe('none')
  })

  it('plays the recording, shows its progress, and is back at the start when it ends', async () => {
    render(VoicePlayer, { src: clip(0.6), durationMs: 600 })
    await page.getByTestId('voice-player-toggle').click()
    await expect.element(page.getByTestId('voice-player')).toHaveAttribute('data-state', 'playing')
    await expect.element(page.getByTestId('voice-player-toggle')).toHaveAccessibleName('Pause voice message')
    await expect.poll(() => Number(page.getByTestId('voice-player-seek').element().getAttribute('aria-valuenow')), { timeout: 5_000 }).toBeGreaterThan(0)
    await expect.element(page.getByTestId('voice-player')).toHaveAttribute('data-state', 'idle', { timeout: 5_000 })
    await expect.element(page.getByTestId('voice-player-toggle')).toHaveAccessibleName('Play voice message')
    await expect.element(page.getByTestId('voice-player-seek')).toHaveAttribute('aria-valuenow', '0')
    await expect.element(page.getByTestId('voice-player-time')).toHaveTextContent('0:00')
  })

  it('pauses where it is, and plays on from there', async () => {
    render(VoicePlayer, { src: clip(5), durationMs: 5_000 })
    await page.getByTestId('voice-player-toggle').click()
    await expect.element(page.getByTestId('voice-player')).toHaveAttribute('data-state', 'playing')
    await expect.poll(() => (page.getByTestId('voice-player-audio').element() as HTMLAudioElement).currentTime).toBeGreaterThan(0.2)
    await page.getByTestId('voice-player-toggle').click()
    await expect.element(page.getByTestId('voice-player')).toHaveAttribute('data-state', 'paused')
    const audio = page.getByTestId('voice-player-audio').element() as HTMLAudioElement
    expect(audio.paused).toBe(true)
    const at = audio.currentTime
    expect(at).toBeGreaterThan(0)
    await page.getByTestId('voice-player-toggle').click()
    await expect.element(page.getByTestId('voice-player')).toHaveAttribute('data-state', 'playing')
    expect(audio.currentTime).toBeGreaterThanOrEqual(at)
    await page.getByTestId('voice-player-toggle').click()
  })

  it('seeking jumps within the recording', async () => {
    render(VoicePlayer, { src: clip(4), durationMs: 4_000 })
    const seek = page.getByTestId('voice-player-seek')
    await seek.fill('2')
    const audio = page.getByTestId('voice-player-audio').element() as HTMLAudioElement
    await expect.poll(() => audio.currentTime).toBeCloseTo(2, 0)
    await expect.element(page.getByTestId('voice-player-time')).toHaveTextContent('0:02')
  })

  it('only one recording plays at a time', async () => {
    render(VoicePlayer, { src: clip(5), durationMs: 5_000, testid: 'first' })
    render(VoicePlayer, { src: clip(5), durationMs: 5_000, testid: 'second' })
    await page.getByTestId('first-toggle').click()
    await expect.element(page.getByTestId('first')).toHaveAttribute('data-state', 'playing')
    await page.getByTestId('second-toggle').click()
    await expect.element(page.getByTestId('second')).toHaveAttribute('data-state', 'playing')
    await expect.element(page.getByTestId('first')).toHaveAttribute('data-state', 'paused')
    await page.getByTestId('second-toggle').click()
  })

  it('a recording that cannot be loaded says so instead of pretending to play', async () => {
    render(VoicePlayer, { src: 'data:audio/webm;base64,AAAA', durationMs: 3_000 })
    await page.getByTestId('voice-player-toggle').click()
    await expect.element(page.getByTestId('voice-player')).toHaveAttribute('data-state', 'error')
    await expect.element(page.getByTestId('voice-player-error')).toHaveTextContent('Recording unavailable')
  })
})
