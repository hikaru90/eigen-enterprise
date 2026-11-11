/**
 * What the client is told when the provider failed all its attempts; the cause stays in the log.
 * Lives here because a +server.ts may only export request handlers (the release build rejects others).
 */
export const TRANSCRIBE_FAILED_MESSAGE = 'Transcription failed'
