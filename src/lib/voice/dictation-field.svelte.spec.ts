import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { page as appPage } from '$app/state'
import Input from '$lib/components/ui/input/input.svelte'
import Textarea from '$lib/components/ui/textarea/textarea.svelte'
import { FakeMediaRecorder, installVoiceDoubles } from '$lib/test/voice-doubles'
import { DICTATION_MISSING_MESSAGE } from './dictation-readiness'
import { VOICE_FAILURE_TEXT } from './voice-failure-message'

/**
 * Voice input on every free-text field (plan/shared-memory-voice-agent-tools.md §2): the
 * shared Input and Textarea carry the one dictation control. Record → Done → the transcript
 * goes in at the cursor; nothing is sent; denied mics and a company without speech-to-text
 * say so on screen.
 */

const ok = (transcript: string) => new Response(JSON.stringify({ transcript }), { status: 200 })
const SIGNED_IN = { shell: { dictation: { ready: true } } }

describe('dictation on the shared fields', () => {
  let doubles: ReturnType<typeof installVoiceDoubles>
  const fetchMock = vi.fn()

  beforeEach(() => {
    doubles = installVoiceDoubles()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(ok('and Ben'))
    vi.stubGlobal('fetch', fetchMock)
    appPage.data = SIGNED_IN
  })
  afterEach(() => {
    doubles.restore()
    vi.unstubAllGlobals()
    appPage.data = {}
  })

  async function dictate(testid: string): Promise<void> {
    await page.getByTestId(`${testid}-voice-mic`).click()
    await expect.element(page.getByTestId(`${testid}-voice-bar`)).toBeInTheDocument()
    FakeMediaRecorder.instances.at(-1)!.emitChunk([1, 2, 3])
    await page.getByTestId(`${testid}-voice-send`).click()
    await expect.element(page.getByTestId(`${testid}-voice-mic`)).toBeInTheDocument()
  }

  it('Input: the transcript goes in at the cursor, the caret lands after it, and the field hears an input event', async () => {
    const oninput = vi.fn()
    render(Input, { 'data-testid': 'title', value: 'Call Ana tomorrow', oninput })
    const el = page.getByTestId('title').element() as HTMLInputElement
    el.focus()
    el.setSelectionRange(8, 8)
    await dictate('title')
    await expect.element(page.getByTestId('title')).toHaveValue('Call Ana and Ben tomorrow')
    expect(document.activeElement).toBe(el)
    expect(el.selectionStart).toBe('Call Ana and Ben'.length)
    expect(oninput).toHaveBeenCalled()
  })

  it('a field the person never put the cursor in gets the transcript appended', async () => {
    render(Input, { 'data-testid': 'title', value: 'Call Ana' })
    await dictate('title')
    await expect.element(page.getByTestId('title')).toHaveValue('Call Ana and Ben')
  })

  it('never sends: the form around the field is not submitted', async () => {
    const onsubmit = vi.fn((e: SubmitEvent) => e.preventDefault())
    const form = document.createElement('form')
    form.addEventListener('submit', onsubmit)
    document.body.append(form)
    render(Input, { target: form, props: { 'data-testid': 'title' } })
    await dictate('title')
    await expect.element(page.getByTestId('title')).toHaveValue('and Ben')
    expect(onsubmit).not.toHaveBeenCalled()
    form.remove()
  })

  it('recording shows the bar with Done (stop) and Discard; Discard keeps the text and gives the field back focus', async () => {
    render(Input, { 'data-testid': 'title', value: 'Keep me' })
    await page.getByTestId('title-voice-mic').click()
    await expect.element(page.getByTestId('title-voice-timer')).toBeInTheDocument()
    await expect.element(page.getByTestId('title-voice-send')).toBeInTheDocument()
    await page.getByTestId('title-voice-discard').click()
    await expect.element(page.getByTestId('title-voice-mic')).toBeInTheDocument()
    await expect.element(page.getByTestId('title')).toHaveValue('Keep me')
    expect(document.activeElement).toBe(page.getByTestId('title').element())
    expect(fetchMock).not.toHaveBeenCalled()
    // the microphone is released
    expect(doubles.stream.tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true)
  })

  it('a denied microphone is said on screen', async () => {
    doubles.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    render(Input, { 'data-testid': 'title' })
    await page.getByTestId('title-voice-mic').click()
    await expect.element(page.getByTestId('title-voice-error')).toHaveTextContent(VOICE_FAILURE_TEXT.permission)
    await expect.element(page.getByRole('alert')).toBeVisible()
  })

  it('without speech-to-text the mic stays in place and a tap says what is missing (never a silent hide)', async () => {
    appPage.data = { shell: { dictation: { ready: false, missing: 'openrouter_key' } } }
    render(Input, { 'data-testid': 'title' })
    const mic = page.getByTestId('title-voice-mic')
    await expect.element(mic).toBeVisible()
    await expect.element(mic).toHaveAttribute('aria-disabled', 'true')
    await mic.click({ force: true }) // aria-disabled: still tappable, it explains itself
    await expect.element(page.getByTestId('title-voice-error')).toHaveTextContent(DICTATION_MISSING_MESSAGE.openrouter_key)
    expect(doubles.getUserMedia).not.toHaveBeenCalled()
    await page.getByTestId('title-voice-discard').click()
    await expect.element(mic).toBeVisible()
  })

  it('Textarea: the transcript goes in at the cursor of a multi-line field', async () => {
    render(Textarea, { 'data-testid': 'notes', value: 'First line\nSecond line' })
    const el = page.getByTestId('notes').element() as HTMLTextAreaElement
    el.focus()
    el.setSelectionRange(10, 10)
    fetchMock.mockResolvedValue(ok('then more'))
    await dictate('notes')
    await expect.element(page.getByTestId('notes')).toHaveValue('First line then more\nSecond line')
  })

  it('is disabled with its field', async () => {
    render(Input, { 'data-testid': 'title', disabled: true })
    await expect.element(page.getByTestId('title-voice-mic')).toBeDisabled()
  })

  it('opts out per field', async () => {
    render(Input, { 'data-testid': 'code', dictation: false })
    render(Textarea, { 'data-testid': 'source', dictation: false })
    await expect.element(page.getByTestId('code')).toBeInTheDocument()
    await expect.element(page.getByTestId('source')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="code-voice-mic"]')).toBeNull()
    expect(document.querySelector('[data-testid="source-voice-mic"]')).toBeNull()
  })

  it.each(['password', 'email', 'number', 'url', 'tel', 'date', 'time', 'search'] as const)(
    'a type=%s field gets no mic',
    async (type) => {
      render(Input, { 'data-testid': 'f', type })
      await expect.element(page.getByTestId('f')).toBeInTheDocument()
      expect(document.querySelector('[data-testid="f-voice-mic"]')).toBeNull()
    },
  )

  it('a one-time code field and a read-only field get no mic', async () => {
    render(Input, { 'data-testid': 'otp', autocomplete: 'one-time-code' })
    render(Textarea, { 'data-testid': 'key', readonly: true })
    await expect.element(page.getByTestId('otp')).toBeInTheDocument()
    await expect.element(page.getByTestId('key')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="otp-voice-mic"]')).toBeNull()
    expect(document.querySelector('[data-testid="key-voice-mic"]')).toBeNull()
  })

  it('outside the signed-in app (sign-in, guest pages) there is no one to transcribe for: no mic', async () => {
    appPage.data = {}
    render(Input, { 'data-testid': 'title' })
    await expect.element(page.getByTestId('title')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="title-voice-mic"]')).toBeNull()
  })
})
