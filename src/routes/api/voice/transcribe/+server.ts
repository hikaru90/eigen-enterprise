import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { onCompanyProvider } from '$lib/server/llm/company-provider'
import { isLlmNotConfiguredError } from '$lib/server/llm/errors'
import { llmChatCompletion } from '$lib/server/llm/llm-client'
import { STT_CLIP_MAX_AUDIO_BYTES, sttFormatFromMime } from '$lib/server/llm/stt-audio'
import { transcribeAudio } from '$lib/server/llm/stt-client'
import { judgeTranscript } from '$lib/server/llm/stt-judge'
import { loadWritingSamples } from '$lib/server/llm/stt-writing-samples'
import { readAudioUpload } from '../../capture/audio-upload'
import { TRANSCRIBE_FAILED_MESSAGE } from './messages'

/**
 * Transcribes one voice message (ported from eigen's voice messages): the whole clip
 * (≤ 5 minutes), once, for any text box that takes dictation (Messages, Contribute). The
 * gateway retries the provider call itself; the audio is never stored and never logged.
 *
 * A company feature any member uses, so it runs on the company's AI provider (the owner's,
 * `onCompanyProvider`) — usage stays attributed to the caller.
 *
 * Silence never becomes text: a non-empty transcript is judged by an LLM (`stt-judge.ts`),
 * shown samples of the person's own recent messages. An artefact of recognition on silence or
 * noise answers `""`, which the client shows as "no speech". A failed judge is a 502 like a
 * failed transcription — the clip stays retryable, the text is never passed through unjudged.
 *
 * Response: `200 { transcript }` (`""` = no speech); `400` empty / oversize / unsupported;
 * `401`; `503` no company AI provider; `502` when the provider still failed.
 */
export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) error(401, 'Unauthorized')

  const audio = await readAudioUpload(event.request, STT_CLIP_MAX_AUDIO_BYTES, sttFormatFromMime)
  const format = sttFormatFromMime(audio.mimeType)
  if (!format) error(400, `unsupported audio type: ${audio.mimeType || 'unknown'}`)

  try {
    const transcript = await onCompanyProvider(async () => {
      const heard = await transcribeAudio({ userId: user.id, audio: { bytes: audio.bytes, format } })
      if (heard === '') return ''
      const verdict = await judgeTranscript(llmChatCompletion, {
        userId: user.id,
        transcript: heard,
        writingSamples: await loadWritingSamples(user.id),
      })
      return verdict === 'artefact' ? '' : heard
    })
    return json({ transcript })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    if (isLlmNotConfiguredError(err)) return json({ error: message }, { status: 503 })
    console.error('voice transcribe failed', { userId: user.id, message })
    return json({ error: TRANSCRIBE_FAILED_MESSAGE }, { status: 502 })
  }
}
