import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { onCompanyProvider } from '$lib/server/llm/company-provider'
import { isLlmNotConfiguredError } from '$lib/server/llm/errors'
import { llmChatCompletion } from '$lib/server/llm/llm-client'
import { STT_CLIP_MAX_AUDIO_BYTES, sttFormatFromMime } from '$lib/server/llm/stt-audio'
import { transcribeAudio } from '$lib/server/llm/stt-client'
import { judgeTranscript } from '$lib/server/llm/stt-judge'
import { loadTranscriptionPrompt } from '$lib/server/llm/stt-vocabulary'
import { loadWritingSamples } from '$lib/server/llm/stt-writing-samples'
import { readAudioUpload } from '../../capture/audio-upload'
import { TRANSCRIBE_FAILED_MESSAGE } from './messages'

const ATTEMPTED = 'Transcribing a voice message (POST /api/voice/transcribe)'

/**
 * Transcribes one voice message (ported from eigen's voice messages): the whole clip
 * (≤ 5 minutes), once, for any text box that takes dictation (Messages, Contribute). The
 * model gets the company's vocabulary (`stt-vocabulary.ts`: company, people, UI language as a
 * hint — no forced language, the model hears which one is spoken). The
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
  if (!user) {
    const r = refusalReport('Unauthorized', { attempted: ATTEMPTED })
    error(401, { message: r.error, agent: r.agent })
  }

  const audio = await readAudioUpload(event.request, STT_CLIP_MAX_AUDIO_BYTES, sttFormatFromMime)
  const format = sttFormatFromMime(audio.mimeType)
  if (!format) {
    const r = refusalReport(`unsupported audio type: ${audio.mimeType || 'unknown'}`, {
      attempted: ATTEMPTED,
      input: { mimeType: audio.mimeType },
    })
    error(400, { message: r.error, agent: r.agent })
  }

  try {
    const transcript = await onCompanyProvider(async () => {
      const prompt = await loadTranscriptionPrompt(user.id)
      // the judge's evidence is read while the model listens, not after
      const samples = loadWritingSamples(user.id)
      samples.catch(() => {}) // awaited below; a rejection is never left unhandled meanwhile
      const heard = await transcribeAudio({
        userId: user.id,
        audio: { bytes: audio.bytes, format, ...(prompt ? { prompt } : {}) },
      })
      if (heard === '') return ''
      const verdict = await judgeTranscript(llmChatCompletion, {
        userId: user.id,
        transcript: heard,
        writingSamples: await samples,
      })
      return verdict === 'artefact' ? '' : heard
    })
    return json({ transcript })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    if (isLlmNotConfiguredError(err)) {
      return json(errorReport(err, { attempted: ATTEMPTED, plain: () => message }), { status: 503 })
    }
    console.error('voice transcribe failed', { userId: user.id, message })
    // The provider's cause stays in the log (above), not on the wire: the report points there.
    return json(
      refusalReport(TRANSCRIBE_FAILED_MESSAGE, {
        attempted: ATTEMPTED,
        nextSteps: [
          'The speech-to-text provider failed after the gateway’s retries: the cause is in the server journal ("voice transcribe failed").',
        ],
      }),
      { status: 502 },
    )
  }
}
