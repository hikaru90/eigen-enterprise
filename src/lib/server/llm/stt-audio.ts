/** Maximum uploaded audio size (bytes). */
export const STT_MAX_AUDIO_BYTES = 10 * 1024 * 1024

/** Longest voice message the recorder sends (it ends the recording and sends at this length). */
export const STT_CLIP_MAX_SECONDS = 300

/**
 * Maximum bytes for one voice message. Sized for 5 minutes of the largest format a recorder
 * emits (MP4/WebM at the 32 kbps the client asks for ≈ 1.2 MB) with generous headroom, because
 * encoders treat the bitrate as a hint and containers add overhead.
 */
export const STT_CLIP_MAX_AUDIO_BYTES = 8 * 1024 * 1024

const MIME_TO_FORMAT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
}

/**
 * Maps browser/server MIME type to OpenRouter/EuRouter `input_audio.format`.
 */
export function sttFormatFromMime(mime: string): string | null {
  const normalized = mime.trim().toLowerCase().split(';')[0]?.trim() ?? ''
  return MIME_TO_FORMAT[normalized] ?? null
}
