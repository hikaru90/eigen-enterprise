import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { getVoicePlayback, setVoiceSpeed, setVoiceVolume } from '$lib/speech/tts'
import VoicePlaybackControls from './voice-playback-controls.svelte'

/**
 * The reading voice's speed and volume (owner proposal 74cbc486), for this browser: the same
 * controls in the chat's voice popover and the settings menu.
 */

function setRange(testid: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)
  if (!input) throw new Error(`no ${testid}`)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('voice-playback-controls.svelte', () => {
  const clear = () => {
    window.localStorage.removeItem('ee-voice-speed')
    window.localStorage.removeItem('ee-voice-volume')
  }
  beforeEach(clear)
  afterEach(clear)

  it('shows the defaults: a little faster than delivered, full volume', async () => {
    render(VoicePlaybackControls)
    await expect.element(page.getByRole('slider', { name: 'Speed' })).toHaveValue('1.15')
    await expect.element(page.getByRole('slider', { name: 'Volume' })).toHaveValue('100')
    await expect.element(page.getByTestId('voice-speed-value')).toHaveTextContent('1.15×')
    await expect.element(page.getByTestId('voice-volume-value')).toHaveTextContent('100%')
  })

  it('offers 0.75× to 2× and 0% to 100%', async () => {
    render(VoicePlaybackControls)
    const speed = page.getByRole('slider', { name: 'Speed' })
    await expect.element(speed).toHaveAttribute('min', '0.75')
    await expect.element(speed).toHaveAttribute('max', '2')
    const volume = page.getByRole('slider', { name: 'Volume' })
    await expect.element(volume).toHaveAttribute('min', '0')
    await expect.element(volume).toHaveAttribute('max', '100')
  })

  it('moving a slider sets the voice for this browser and says the new value', async () => {
    render(VoicePlaybackControls)
    await expect.element(page.getByTestId('voice-speed')).toBeInTheDocument()
    setRange('voice-speed', '1.6')
    setRange('voice-volume', '40')
    expect(getVoicePlayback()).toEqual({ speed: 1.6, volume: 0.4 })
    await expect.element(page.getByTestId('voice-speed-value')).toHaveTextContent('1.6×')
    await expect.element(page.getByTestId('voice-volume-value')).toHaveTextContent('40%')
  })

  it('a browser that does not let pages set the volume (iPhone, iPad) says so instead of a dead slider', async () => {
    render(VoicePlaybackControls, { canSetVolume: false })
    await expect.element(page.getByRole('slider', { name: 'Speed' })).toBeInTheDocument()
    await expect.element(page.getByRole('slider', { name: 'Volume' })).not.toBeInTheDocument()
    await expect
      .element(page.getByTestId('voice-volume-unsupported'))
      .toHaveTextContent('This browser does not let pages set the volume')
  })

  it('starts from what was chosen before, and follows a change made elsewhere', async () => {
    setVoiceSpeed(0.9)
    render(VoicePlaybackControls)
    await expect.element(page.getByRole('slider', { name: 'Speed' })).toHaveValue('0.9')
    setVoiceVolume(0.25)
    await expect.element(page.getByRole('slider', { name: 'Volume' })).toHaveValue('25')
  })
})
