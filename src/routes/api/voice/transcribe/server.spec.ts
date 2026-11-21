import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { POST } from './+server'
import { TRANSCRIBE_FAILED_MESSAGE } from './messages'

const m = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  judgeTranscript: vi.fn(),
  loadWritingSamples: vi.fn(),
  loadTranscriptionPrompt: vi.fn(),
  onCompanyProvider: vi.fn(),
  llmChatCompletion: vi.fn(),
}))

vi.mock('$lib/server/llm/stt-client', () => ({ transcribeAudio: m.transcribeAudio }))
vi.mock('$lib/server/llm/stt-vocabulary', () => ({
  loadTranscriptionPrompt: m.loadTranscriptionPrompt,
}))
vi.mock('$lib/server/llm/stt-writing-samples', () => ({ loadWritingSamples: m.loadWritingSamples }))
vi.mock('$lib/server/llm/llm-client', () => ({ llmChatCompletion: m.llmChatCompletion }))
vi.mock('$lib/server/llm/company-provider', () => ({ onCompanyProvider: m.onCompanyProvider }))
vi.mock('$lib/server/llm/stt-judge', () => ({ judgeTranscript: m.judgeTranscript }))

function request(body: Blob) {
  return new Request('http://os.test/api/voice/transcribe', {
    method: 'POST',
    headers: { 'content-type': body.type || 'application/octet-stream' },
    body,
  })
}
const clip = () => new Blob([new Uint8Array(16)], { type: 'audio/webm;codecs=opus' })
const call = (body: Blob, user: { id: string } | null = { id: 'u1' }) =>
  POST({ locals: { user }, request: request(body) } as never)

describe('POST /api/voice/transcribe', () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockReset()
    m.onCompanyProvider.mockImplementation((fn: () => Promise<unknown>) => fn())
    m.loadWritingSamples.mockResolvedValue(['hallo'])
    m.loadTranscriptionPrompt.mockResolvedValue(
      'Dictation in the workspace of Acme. Names that may come up: Ony.',
    )
  })

  it('401s without a user', async () => {
    await expect(call(clip(), null)).rejects.toMatchObject({ status: 401 })
  })

  it('400s an unsupported audio type before any provider call', async () => {
    await expect(call(new Blob([new Uint8Array(4)], { type: 'text/plain' }))).rejects.toMatchObject(
      { status: 400 },
    )
    expect(m.transcribeAudio).not.toHaveBeenCalled()
  })

  it('transcribes on the company provider and returns judged dictation', async () => {
    m.transcribeAudio.mockResolvedValue('ship the release')
    m.judgeTranscript.mockResolvedValue('dictation')
    const res = await call(clip())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ transcript: 'ship the release' })
    expect(m.onCompanyProvider).toHaveBeenCalledTimes(1)
    expect(m.transcribeAudio).toHaveBeenCalledWith({
      userId: 'u1',
      audio: expect.objectContaining({
        format: 'webm',
        prompt: 'Dictation in the workspace of Acme. Names that may come up: Ony.',
      }),
    })
    // no forced language: the model hears which one is spoken
    expect(m.transcribeAudio.mock.calls[0]![0].audio).not.toHaveProperty('language')
    expect(m.judgeTranscript).toHaveBeenCalledWith(m.llmChatCompletion, {
      userId: 'u1',
      transcript: 'ship the release',
      writingSamples: ['hallo'],
    })
  })

  it("reads the judge's evidence while the model listens, not after it", async () => {
    let heardDone = false
    m.loadWritingSamples.mockImplementation(async () => {
      expect(heardDone).toBe(false)
      return []
    })
    m.transcribeAudio.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      heardDone = true
      return 'hallo'
    })
    m.judgeTranscript.mockResolvedValue('dictation')
    expect(await (await call(clip())).json()).toEqual({ transcript: 'hallo' })
    expect(m.loadWritingSamples).toHaveBeenCalledTimes(1)
  })

  it('answers "" for an artefact of recognition on silence', async () => {
    m.transcribeAudio.mockResolvedValue('thanks for watching')
    m.judgeTranscript.mockResolvedValue('artefact')
    expect(await (await call(clip())).json()).toEqual({ transcript: '' })
  })

  it('answers "" for no speech without asking the judge', async () => {
    m.transcribeAudio.mockResolvedValue('')
    expect(await (await call(clip())).json()).toEqual({ transcript: '' })
    expect(m.judgeTranscript).not.toHaveBeenCalled()
  })

  it('502s a failed judge — the text is never passed through unjudged', async () => {
    m.transcribeAudio.mockResolvedValue('hello')
    m.judgeTranscript.mockRejectedValue(new Error('transcript check failed 3 times'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call(clip())
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({
      error: TRANSCRIBE_FAILED_MESSAGE,
      agent: { attempted: 'Transcribing a voice message (POST /api/voice/transcribe)' },
    })
  })

  it('503s with the setup message when the company has no AI provider', async () => {
    m.onCompanyProvider.mockRejectedValue(
      new LlmNotConfiguredError('The owner sets it up under Settings → AI provider.'),
    )
    const res = await call(clip())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      error: 'The owner sets it up under Settings → AI provider.',
      agent: {
        attempted: 'Transcribing a voice message (POST /api/voice/transcribe)',
        code: 'LlmNotConfiguredError',
      },
    })
  })
})
