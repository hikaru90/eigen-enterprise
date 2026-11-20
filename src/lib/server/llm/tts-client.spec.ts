import { afterEach, describe, expect, it, vi } from 'vitest'

const { llmCreateSpeechMock } = vi.hoisted(() => ({
  llmCreateSpeechMock: vi.fn(),
}))

vi.mock('$lib/server/llm/llm-client', () => ({
  llmCreateSpeech: llmCreateSpeechMock,
}))

const envState = { LLM_TTS_VOICE: undefined as string | undefined }

vi.mock('$lib/server/env/private-env', () => ({
  env: envState,
}))

describe('tts-client — gateway speech synthesis', () => {
  afterEach(() => {
    llmCreateSpeechMock.mockReset()
    envState.LLM_TTS_VOICE = undefined
  })

  it('defaults to a voice the pool TTS model lists, and sends no model (the company TTS slot decides it)', async () => {
    // "alloy" is a voice no OpenRouter speech model lists, so every call failed. Checked
    // 2026-11-11 against GET /api/v1/models?output_modalities=speech (supported_voices).
    llmCreateSpeechMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const { synthesizeSpeech, TTS_VOICE_DEFAULT } = await import('./tts-client')
    expect(TTS_VOICE_DEFAULT).toBe('longanhuan_v3.6')

    await synthesizeSpeech({ userId: 'u1', text: 'Hello from the boot sequence.' })
    expect(llmCreateSpeechMock).toHaveBeenCalledWith({
      userId: 'u1',
      voice: 'longanhuan_v3.6',
      text: 'Hello from the boot sequence.',
    })
  })

  it('honors the LLM_TTS_VOICE env override (a voice, not a model)', async () => {
    llmCreateSpeechMock.mockResolvedValue(new Uint8Array())
    envState.LLM_TTS_VOICE = 'narrator'
    const { synthesizeSpeech } = await import('./tts-client')

    await synthesizeSpeech({ userId: 'u1', text: 'hello' })
    expect(llmCreateSpeechMock).toHaveBeenCalledWith(expect.objectContaining({ voice: 'narrator' }))
  })

  it('refuses empty text at the door', async () => {
    const { synthesizeSpeech } = await import('./tts-client')
    await expect(synthesizeSpeech({ userId: 'u1', text: '   ' })).rejects.toThrow(/empty/i)
    expect(llmCreateSpeechMock).not.toHaveBeenCalled()
  })
})
