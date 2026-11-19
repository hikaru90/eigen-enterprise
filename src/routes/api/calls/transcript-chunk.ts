import type { TranscriptChunk } from '../../../../modules/calls/service'
import { error } from '@sveltejs/kit'
import { sttFormatFromMime } from '$lib/server/llm/stt-audio'
import { MAX_CHUNK_BYTES } from '../../../../modules/calls/transcript'
import { readAudioUpload } from '../capture/audio-upload'

/** The header carrying how long the chunk lasts, in whole milliseconds (the server times the segment by it). */
export const CHUNK_DURATION_HEADER = 'x-chunk-duration-ms'

/**
 * One transcript chunk from the request (call transcripts): the raw audio
 * body (its MIME type as content-type — exempt from SvelteKit's CSRF origin
 * check, like dictation) and its duration header. A missing or malformed
 * part is a 400 here; the service checks the rest (size, duration range).
 * The bytes stay in memory for the one transcription and are never stored.
 */
export async function readTranscriptChunk(request: Request): Promise<TranscriptChunk> {
  const raw = request.headers.get(CHUNK_DURATION_HEADER)?.trim() ?? ''
  if (!/^\d{1,9}$/.test(raw)) error(400, `${CHUNK_DURATION_HEADER} must be the chunk's length in milliseconds`)
  const audio = await readAudioUpload(request, MAX_CHUNK_BYTES, sttFormatFromMime)
  const format = sttFormatFromMime(audio.mimeType)
  if (!format) error(400, `unsupported audio type: ${audio.mimeType || 'unknown'}`)
  return { bytes: audio.bytes, format, durationMs: Number(raw) }
}
