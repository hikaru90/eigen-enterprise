import { describe, expect, it, vi, beforeEach } from 'vitest'
import { parseSttTranscript, STT_MODEL, transcribeAudio } from './stt-client'

const { llmCreateTranscriptionMock } = vi.hoisted(() => ({
  llmCreateTranscriptionMock: vi.fn(),
}))

vi.mock('./llm-client', () => ({
  llmCreateTranscription: llmCreateTranscriptionMock,
}))

// an old LLM_MODEL_STT in a deployment's env must not route around the pinned model
vi.mock('$lib/server/env/private-env', () => ({
  env: { LLM_MODEL_STT: 'qwen/qwen3-asr-flash-2026-02-10' },
}))

describe('parseSttTranscript', () => {
  it('extracts trimmed text from dedicated STT body', () => {
    expect(parseSttTranscript({ text: '  hello  ' })).toBe('hello')
  })

  it('rejects chat completion body so assistant replies are not treated as transcripts', () => {
    expect(() =>
      parseSttTranscript({ choices: [{ message: { content: '  spoken words  ' } }] }),
    ).toThrow(/chat completion shape/)
  })

  it('treats an empty text as a real answer: the clip held no speech', () => {
    expect(parseSttTranscript({ text: '   ' })).toBe('')
  })

  it('throws when text missing', () => {
    expect(() => parseSttTranscript({})).toThrow(/missing transcript/)
  })
})

describe('transcribeAudio', () => {
  beforeEach(() => {
    llmCreateTranscriptionMock.mockReset()
  })

  it('pins eigen\'s model: qwen3-asr-0.6b (qwen3-asr-flash-2026-02-10 has no OpenRouter endpoints, so every clip failed)', () => {
    expect(STT_MODEL).toBe('qwen/qwen3-asr-0.6b')
  })

  it('calls the gateway with the pinned STT model, whatever the env says', async () => {
    llmCreateTranscriptionMock.mockResolvedValue({ text: 'typed speech' })
    const out = await transcribeAudio({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1, 2, 3]), format: 'webm', language: 'en' },
    })
    expect(out).toBe('typed speech')
    expect(llmCreateTranscriptionMock).toHaveBeenCalledWith({
      userId: 'u1',
      model: 'qwen/qwen3-asr-0.6b',
      audio: { bytes: new Uint8Array([1, 2, 3]), format: 'webm', language: 'en' },
    })
  })
})
