import type { VoiceFailure } from './voice-message'

export const VOICE_FAILURE_TEXT = {
  permission: 'Microphone permission denied',
  microphone: "Couldn't access the microphone",
  recorder: 'Recording failed',
  interrupted: 'The recording was interrupted',
  empty: 'No speech detected',
  transcribe: "Couldn't transcribe the recording",
} as const

/**
 * The plain sentence for a failed voice message. The server's own words are shown only where
 * they say something the person can act on — a rejected upload that names its limit (400) or
 * a company without an AI provider (503, "the owner sets it up under Settings → AI provider");
 * anything else a provider or the network said stays in the logs.
 */
export function voiceFailureMessage(failure: VoiceFailure): string {
  switch (failure.reason) {
    case 'permission':
    case 'microphone':
    case 'recorder':
    case 'interrupted':
    case 'empty':
      return VOICE_FAILURE_TEXT[failure.reason]
    case 'request':
      return (failure.status === 400 || failure.status === 503) && failure.detail
        ? failure.detail
        : VOICE_FAILURE_TEXT.transcribe
  }
}
