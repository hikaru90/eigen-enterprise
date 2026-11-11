/**
 * Every refusal the Calls module gives, typed. `not_configured` is the one
 * the UI shows as "Calls are not set up on this server" (LiveKit env missing).
 */
export type CallsErrorCode = 'not_found' | 'forbidden' | 'invalid' | 'conflict' | 'not_configured'

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
