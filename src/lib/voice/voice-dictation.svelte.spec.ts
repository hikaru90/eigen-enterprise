import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { page as appPage } from '$app/state'
import { FakeMediaRecorder, installVoiceDoubles } from '$lib/test/voice-doubles'
import MessageComposer from '$lib/messages/message-composer.svelte'
import MessageEdit from '$lib/messages/message-edit.svelte'
import ContributeComposer from '$lib/components/contribute/contribute-composer.svelte'
import { DICTATION_MISSING_MESSAGE } from './dictation-readiness'
import { VOICE_TRANSCRIBE_URL } from './transcribe-voice-clip'
import { VOICE_FAILURE_TEXT } from './voice-failure-message'
import VoiceDictation from './voice-dictation.svelte'

const ok = (transcript: string) => new Response(JSON.stringify({ transcript }), { status: 200 })
const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status })

describe('voice-dictation.svelte', () => {
  let doubles: ReturnType<typeof installVoiceDoubles>
  const fetchMock = vi.fn()

  beforeEach(() => {
    doubles = installVoiceDoubles()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    doubles.restore()
    vi.unstubAllGlobals()
    appPage.data = {}
  })

  it('when dictation cannot work, the mic says what is missing instead of failing after a recording', async () => {
    appPage.data = { shell: { dictation: { ready: false, missing: 'openrouter_key' } } }
    render(VoiceDictation, { ontranscript: vi.fn() })
    const mic = page.getByTestId('voice-mic')
    await expect.element(mic).toBeDisabled()
    await expect.element(mic).toHaveAttribute('title', DICTATION_MISSING_MESSAGE.openrouter_key)
    expect(doubles.getUserMedia).not.toHaveBeenCalled()
  })

  it('names the server’s missing key on platform credits', async () => {
    appPage.data = { shell: { dictation: { ready: false, missing: 'platform_key' } } }
    render(VoiceDictation, { ontranscript: vi.fn() })
    await expect
      .element(page.getByTestId('voice-mic'))
      .toHaveAttribute('title', DICTATION_MISSING_MESSAGE.platform_key)
  })

  it('a ready company gets the normal mic', async () => {
    appPage.data = { shell: { dictation: { ready: true } } }
    render(VoiceDictation, { ontranscript: vi.fn() })
    await expect.element(page.getByTestId('voice-mic')).toBeEnabled()
    await expect.element(page.getByTestId('voice-mic')).toHaveAttribute('title', 'Dictate (speech to text)')
  })

  async function record(testid = 'voice') {
    await page.getByTestId(`${testid}-mic`).click()
    await expect.element(page.getByTestId(`${testid}-bar`)).toBeInTheDocument()
    FakeMediaRecorder.instances.at(-1)!.emitChunk([1, 2, 3])
  }

  it('the mic becomes the bar; Done uploads the whole clip once and hands back the transcript', async () => {
    fetchMock.mockResolvedValue(ok('ship the release'))
    const ontranscript = vi.fn()
    render(VoiceDictation, { ontranscript })
    await record()
    await expect.element(page.getByTestId('voice-timer')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    await page.getByTestId('voice-send').click()
    await expect.poll(() => ontranscript.mock.calls.length).toBe(1)
    expect(ontranscript).toHaveBeenCalledWith('ship the release')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(VOICE_TRANSCRIBE_URL)
    await expect.element(page.getByTestId('voice-mic')).toBeInTheDocument()
    // the microphone is released
    expect(doubles.stream.tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true)
  })

  it('discard drops the recording and sends nothing', async () => {
    const ontranscript = vi.fn()
    render(VoiceDictation, { ontranscript })
    await record()
    await page.getByTestId('voice-discard').click()
    await expect.element(page.getByTestId('voice-mic')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ontranscript).not.toHaveBeenCalled()
  })

  it('a failed upload shows the plain error with Retry, which sends the same clip again', async () => {
    fetchMock.mockResolvedValueOnce(fail(502, 'Transcription failed')).mockResolvedValueOnce(ok('second try'))
    const ontranscript = vi.fn()
    render(VoiceDictation, { ontranscript })
    await record()
    await page.getByTestId('voice-send').click()
    await expect.element(page.getByTestId('voice-error')).toHaveTextContent(VOICE_FAILURE_TEXT.transcribe)
    await page.getByTestId('voice-retry').click()
    await expect.poll(() => ontranscript.mock.calls.length).toBe(1)
    expect(ontranscript).toHaveBeenCalledWith('second try')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1].body).toBe(fetchMock.mock.calls[0]![1].body)
  })

  it('no speech ("") is said plainly and never reaches the box', async () => {
    fetchMock.mockResolvedValue(ok(''))
    const ontranscript = vi.fn()
    render(VoiceDictation, { ontranscript })
    await record()
    await page.getByTestId('voice-send').click()
    await expect.element(page.getByTestId('voice-error')).toHaveTextContent(VOICE_FAILURE_TEXT.empty)
    expect(ontranscript).not.toHaveBeenCalled()
  })

  it("shows the server's setup message when the company has no AI provider (503)", async () => {
    fetchMock.mockResolvedValue(fail(503, 'The owner sets it up under Settings → AI provider.'))
    render(VoiceDictation, { ontranscript: vi.fn() })
    await record()
    await page.getByTestId('voice-send').click()
    await expect.element(page.getByTestId('voice-error')).toHaveTextContent('Settings → AI provider')
  })

  it('a denied microphone says so and offers no retry', async () => {
    doubles.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    render(VoiceDictation, { ontranscript: vi.fn() })
    await page.getByTestId('voice-mic').click()
    await expect.element(page.getByTestId('voice-error')).toHaveTextContent(VOICE_FAILURE_TEXT.permission)
    await expect.element(page.getByTestId('voice-retry')).not.toBeInTheDocument()
  })

  it('is disabled with its box', async () => {
    render(VoiceDictation, { ontranscript: vi.fn(), disabled: true })
    await expect.element(page.getByTestId('voice-mic')).toBeDisabled()
  })
})

describe('dictation in the text boxes', () => {
  let doubles: ReturnType<typeof installVoiceDoubles>
  const fetchMock = vi.fn()

  beforeEach(() => {
    doubles = installVoiceDoubles()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(ok('and the dashboard'))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    doubles.restore()
    vi.unstubAllGlobals()
  })

  async function dictate(testid: string) {
    await page.getByTestId(`${testid}-mic`).click()
    await expect.element(page.getByTestId(`${testid}-bar`)).toBeInTheDocument()
    FakeMediaRecorder.instances.at(-1)!.emitChunk([1, 2, 3])
    await page.getByTestId(`${testid}-send`).click()
    await expect.element(page.getByTestId(`${testid}-mic`)).toBeInTheDocument()
  }

  it('message composer: the bar takes the bottom row; the transcript is appended to what was typed', async () => {
    render(MessageComposer, {
      value: 'Fix the login',
      placeholder: 'Message',
      label: 'Message',
      canSend: true,
      emoji: ['👍'],
      inputTestid: 'composer',
      sendTestid: 'composer-send',
      onsend: vi.fn(),
    })
    await page.getByTestId('composer-voice-mic').click()
    await expect.element(page.getByTestId('composer-send')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('composer-emoji')).not.toBeInTheDocument()
    FakeMediaRecorder.instances.at(-1)!.emitChunk([1])
    await page.getByTestId('composer-voice-send').click()
    await expect.element(page.getByTestId('composer')).toHaveValue('Fix the login and the dashboard')
    await expect.element(page.getByTestId('composer-send')).toBeInTheDocument()
  })

  it('message edit: dictation appends to the edited body', async () => {
    const onsave = vi.fn()
    render(MessageEdit, { body: 'Moved the meeting', onsave, oncancel: vi.fn() })
    await dictate('messages-edit-voice')
    await expect.element(page.getByTestId('messages-edit-input')).toHaveValue('Moved the meeting and the dashboard')
    await page.getByTestId('messages-edit-save').click()
    expect(onsave).toHaveBeenCalledWith('Moved the meeting and the dashboard')
  })

  it('contribute composer: dictation fills the proposal', async () => {
    const client = { check: vi.fn(), share: vi.fn(), vote: vi.fn() }
    render(ContributeComposer, { client, boardHref: '/contribute' })
    await dictate('contribute-voice')
    await expect.element(page.getByTestId('contribute-input')).toHaveValue('and the dashboard')
    await expect.element(page.getByTestId('contribute-send')).toBeEnabled()
  })
})
