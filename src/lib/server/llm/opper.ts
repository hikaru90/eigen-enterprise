import { LlmNotConfiguredError } from './errors'
import type { ResolvedLlmConfig } from './types'

/**
 * Opper's call shapes for eigenInference on Opper (platform-ai.ts; contract checked live
 * 2026-11-27). The configured base is Opper's OpenAI-compatible API (`…/v3/compat`); chat and
 * embeddings go to it as to any OpenAI-compatible endpoint. Speech and decisions differ:
 * - speech sits beside it: `<base without /compat>/audio/transcriptions` and `/audio/speech`,
 *   JSON in and JSON out (the audio as a data URL; the spoken audio as base64);
 * - decisions take the Decisions body unchanged at `<base>/v1/systemone`.
 * Paths are derived from the configured base, never from a host name.
 */

const COMPAT = '/compat'

function compatBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (!base.endsWith(COMPAT)) {
    throw new LlmNotConfiguredError(
      `eigenInference on Opper needs Opper's OpenAI-compatible API as its base (ending in ${COMPAT}); ${base} is not one.`,
    )
  }
  return base
}

export function opperAudioUrl(baseUrl: string, path: 'transcriptions' | 'speech'): string {
  return `${compatBase(baseUrl).slice(0, -COMPAT.length)}/audio/${path}`
}

export function opperDecisionsUrl(baseUrl: string): string {
  return `${compatBase(baseUrl)}/v1/systemone`
}

/** The media type of each audio format the recorder and uploads produce (stt-audio.ts). */
const FORMAT_TO_MIME: Record<string, string> = {
  webm: 'audio/webm',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
}

export function opperTranscriptionBody(
  model: string,
  audio: { bytes: Uint8Array; format: string; language?: string },
): { model: string; audio: string; language?: string } {
  const mime = FORMAT_TO_MIME[audio.format]
  if (!mime) throw new Error(`Speech to text on Opper: the audio format "${audio.format}" has no known media type.`)
  return {
    model,
    audio: `data:${mime};base64,${Buffer.from(audio.bytes).toString('base64')}`,
    ...(audio.language ? { language: audio.language } : {}),
  }
}

/** The spoken audio of an Opper `/audio/speech` answer (`audio.b64_json`); fails loud without it. */
export function opperSpeechAudio(body: unknown): Uint8Array {
  const b64 = (body as { audio?: { b64_json?: unknown } } | null)?.audio?.b64_json
  if (typeof b64 !== 'string' || b64 === '') throw new Error('Text to speech on Opper answered with no audio.')
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** Opper's request tags: comma-separated key:value pairs (at most 8; a malformed one is a 400). */
export const OPPER_TAGS_HEADER = 'X-Opper-Tags'

/**
 * The box's usage tag on an eigenInference call served by Opper (`ee_box:<tag>`, the fleet's
 * platformAi.usageTag), so the hosting can hold a box's usage report against Opper's numbers.
 * Only the endpoints Opper documents tags for take it: chat completions and embeddings (not
 * speech, not decisions). Nothing for any other provider or without a tag.
 */
export function opperUsageTagHeaders(
  config: Pick<ResolvedLlmConfig, 'eigenInferenceProvider' | 'eigenInferenceUsageTag'>,
): Record<string, string> {
  if (config.eigenInferenceProvider !== 'opper' || !config.eigenInferenceUsageTag) return {}
  return { [OPPER_TAGS_HEADER]: `ee_box:${config.eigenInferenceUsageTag}` }
}
