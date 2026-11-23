import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { setVoiceEnabled, speak } from '$lib/speech/tts'
import VoiceOutputToggle from './voice-output-toggle.svelte'

/**
 * The speaker in the assistant's composer (Contribute b34ce781): the same `ee-voice` switch as
 * the settings menu; off stops the current reading at once.
 */

describe('voice-output-toggle.svelte', () => {
  let pause: ReturnType<typeof vi.fn>
  let played: object[]

  beforeEach(() => {
    window.localStorage.removeItem('ee-voice')
    window.localStorage.removeItem('ee-voice-speed')
    window.localStorage.removeItem('ee-voice-volume')
    pause = vi.fn()
    played = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }), { status: 200 }),
      ),
    )
    vi.stubGlobal(
      'Audio',
      class {
        src: string
        onended: (() => void) | null = null
        constructor(src: string) {
          this.src = src
        }
        playbackRate = 1
        preservesPitch = false
        volume = 1
        play = vi.fn(async () => {
          played.push(this)
        })
        pause = pause
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.removeItem('ee-voice')
    window.localStorage.removeItem('ee-voice-speed')
    window.localStorage.removeItem('ee-voice-volume')
  })

  const toggle = () => page.getByTestId('assistant-voice-toggle')

  it('shows the voice as on by default, and off once switched off — the one ee-voice setting', async () => {
    render(VoiceOutputToggle)
    await expect.element(toggle()).toHaveAttribute('aria-checked', 'true')
    await toggle().click()
    await expect.element(toggle()).toHaveAttribute('aria-checked', 'false')
    expect(window.localStorage.getItem('ee-voice')).toBe('off')
    await toggle().click()
    await expect.element(toggle()).toHaveAttribute('aria-checked', 'true')
    expect(window.localStorage.getItem('ee-voice')).toBeNull()
  })

  it('says what it does and its state — in words, in its tooltip, and to assistive tech (Contribute: clarify the speaker)', async () => {
    render(VoiceOutputToggle)
    await expect
      .element(page.getByRole('switch', { name: 'Read replies aloud: on' }))
      .toBeInTheDocument()
    await expect.element(toggle()).toHaveTextContent('Read replies aloud: On')
    await expect
      .element(toggle())
      .toHaveAttribute(
        'title',
        'Replies are read aloud as they arrive. Click to stop reading them aloud.',
      )
    await toggle().click()
    await expect
      .element(page.getByRole('switch', { name: 'Read replies aloud: off' }))
      .toBeInTheDocument()
    await expect.element(toggle()).toHaveTextContent('Read replies aloud: Off')
    await expect
      .element(toggle())
      .toHaveAttribute('title', 'Replies are not read aloud. Click to have them read aloud.')
  })

  it('starts as off when it was switched off before (in the settings menu or here)', async () => {
    window.localStorage.setItem('ee-voice', 'off')
    render(VoiceOutputToggle)
    await expect.element(toggle()).toHaveAttribute('aria-checked', 'false')
  })

  it('switching off stops the reply being read right now', async () => {
    render(VoiceOutputToggle)
    speak('A long answer that is being read aloud.')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 20))
    await toggle().click()
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('follows the settings menu switch while it is shown', async () => {
    render(VoiceOutputToggle)
    await expect.element(toggle()).toHaveAttribute('aria-checked', 'true')
    setVoiceEnabled(false)
    await expect.element(toggle()).toHaveAttribute('aria-checked', 'false')
  })
  it('opens speed and volume from a small popover beside the switch (owner proposal 74cbc486)', async () => {
    render(VoiceOutputToggle)
    const open = page.getByRole('button', { name: 'Voice speed and volume' })
    await expect.element(open).toBeInTheDocument()
    await open.click()
    await expect.element(page.getByRole('slider', { name: 'Speed' })).toHaveValue('1.15')
    await expect.element(page.getByRole('slider', { name: 'Volume' })).toHaveValue('100')
  })

  it('a change in the popover applies to the reply being read right now', async () => {
    render(VoiceOutputToggle)
    speak('A long answer that is being read aloud.')
    await vi.waitFor(() => expect(played).toHaveLength(1))
    const audio = played[0] as { playbackRate: number; volume: number; preservesPitch: boolean }
    expect(audio.playbackRate).toBe(1.15)
    expect(audio.preservesPitch).toBe(true)
    await page.getByRole('button', { name: 'Voice speed and volume' }).click()
    await expect.element(page.getByTestId('voice-speed')).toBeInTheDocument()
    for (const [testid, value] of [
      ['voice-speed', '1.8'],
      ['voice-volume', '30'],
    ] as const) {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)!
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    expect(audio.playbackRate).toBe(1.8)
    expect(audio.volume).toBe(0.3)
  })
})
