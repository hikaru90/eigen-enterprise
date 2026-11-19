/**
 * Every refusal the Calls module gives, typed. `not_configured` is the one
 * the UI shows as "Calls are not set up on this server" (LiveKit env missing).
 * `unavailable`: a part of the call that needs something else the server has
 * not set up (speech to text for transcripts); the call itself works.
 */
export type CallsErrorCode = 'not_found' | 'forbidden' | 'invalid' | 'conflict' | 'not_configured' | 'unavailable'

export class CallsError extends Error {
  constructor(
    readonly code: CallsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CallsError'
  }
}

export const CALLS_NOT_SET_UP = 'Calls are not set up on this server'
