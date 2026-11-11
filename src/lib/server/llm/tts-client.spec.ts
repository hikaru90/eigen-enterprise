import { afterEach, describe, expect, it, vi } from 'vitest'

const { llmCreateSpeechMock } = vi.hoisted(() => ({
  llmCreateSpeechMock: vi.fn(),
}))

vi.mock('$lib/server/llm/llm-client', () => ({
  llmCreateSpeech: llmCreateSpeechMock,
}))

const envState = { LLM_MODEL_TTS: undefined as string | undefined, LLM_TTS_VOICE: undefined as string | undefined }

vi.mock('$lib/server/env/private-env', () => ({
  env: envState,
}))

describe('tts-client — gateway speech synthesis', () => {
  afterEach(() => {
    llmCreateSpeechMock.mockReset()
    envState.LLM_MODEL_TTS = undefined
    envState.LLM_TTS_VOICE = undefined
  })

  it('defaults to a Qwen voice model that OpenRouter serves, with a voice that model lists', async () => {
    // qwen/qwen3-tts-flash-2026-02-10 had no OpenRouter endpoints and "alloy" is a voice
    // no OpenRouter speech model lists, so every call failed. Checked 2026-11-11 against
    // GET /api/v1/models?output_modalities=speech (supported_voices) and /endpoints.
    llmCreateSpeechMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const { synthesizeSpeech, TTS_MODEL_OPENROUTER_DEFAULT, TTS_VOICE_DEFAULT } = await import('./tts-client')
    expect(TTS_MODEL_OPENROUTER_DEFAULT).toBe('qwen/qwen-audio-3.0-tts-flash')
    expect(TTS_VOICE_DEFAULT).toBe('longanhuan_v3.6')

    await synthesizeSpeech({ userId: 'u1', text: 'Hello from the boot sequence.' })
    expect(llmCreateSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', model: 'qwen/qwen-audio-3.0-tts-flash', voice: 'longanhuan_v3.6' }),
    )
  })

  it('honors the LLM_MODEL_TTS / LLM_TTS_VOICE env overrides', async () => {
    llmCreateSpeechMock.mockResolvedValue(new Uint8Array())
    envState.LLM_MODEL_TTS = 'custom/tts-model'
    envState.LLM_TTS_VOICE = 'narrator'
    const { synthesizeSpeech } = await import('./tts-client')

    await synthesizeSpeech({ userId: 'u1', text: 'hello' })
    expect(llmCreateSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'custom/tts-model', voice: 'narrator' }),
    )
  })

  it('refuses empty text at the door', async () => {
    const { synthesizeSpeech } = await import('./tts-client')
    await expect(synthesizeSpeech({ userId: 'u1', text: '   ' })).rejects.toThrow(/empty/i)
    expect(llmCreateSpeechMock).not.toHaveBeenCalled()
  })
})
