import { describe, expect, it } from 'vitest'
import { LlmNotConfiguredError } from './errors'
import { opperAudioUrl, opperDecisionsUrl, opperSpeechAudio, opperTranscriptionBody } from './opper'

describe('Opper call shapes (eigenInference on Opper; contract checked live 2026-11-27)', () => {
  const base = 'https://api.opper.ai/v3/compat'

  it('speech sits beside the compat API: <base without /compat>/audio/…', () => {
    expect(opperAudioUrl(base, 'transcriptions')).toBe('https://api.opper.ai/v3/audio/transcriptions')
    expect(opperAudioUrl(`${base}/`, 'speech')).toBe('https://api.opper.ai/v3/audio/speech')
  })

  it('decisions go to <base>/v1/systemone (not <base>/decisions, which refuses state)', () => {
    expect(opperDecisionsUrl(base)).toBe('https://api.opper.ai/v3/compat/v1/systemone')
  })

  it('a base that is not a …/compat API fails loud instead of guessing paths', () => {
    expect(() => opperAudioUrl('https://api.opper.ai/v3', 'speech')).toThrow(LlmNotConfiguredError)
    expect(() => opperDecisionsUrl('https://api.opper.ai/v3')).toThrow(/\/compat/)
  })

  it('the transcription body: model, the audio as a data URL of its own type, the language when known', () => {
    expect(opperTranscriptionBody('mistral/voxtral-mini-transcribe-3-0', { bytes: new Uint8Array([1, 2]), format: 'mp3' })).toEqual({
      model: 'mistral/voxtral-mini-transcribe-3-0',
      audio: `data:audio/mpeg;base64,${Buffer.from([1, 2]).toString('base64')}`,
    })
    expect(opperTranscriptionBody('m', { bytes: new Uint8Array([1]), format: 'm4a', language: 'de' })).toMatchObject({
      audio: expect.stringMatching(/^data:audio\/mp4;base64,/),
      language: 'de',
    })
  })

  it('an audio format without a known type fails loud', () => {
    expect(() => opperTranscriptionBody('m', { bytes: new Uint8Array([1]), format: 'amr' })).toThrow(/amr/)
  })

  it('speech answers JSON: the base64 audio is decoded; no audio fails loud', () => {
    expect([...opperSpeechAudio({ audio: { b64_json: Buffer.from([9, 8]).toString('base64'), mime_type: 'audio/mpeg' } })]).toEqual([9, 8])
    expect(() => opperSpeechAudio({ usage: { cost: 1 } })).toThrow(/no audio/)
    expect(() => opperSpeechAudio({ audio: { b64_json: '' } })).toThrow(/no audio/)
  })
})
