/** Contacts failures with their HTTP meaning (http.ts maps them). */
export class ContactsError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden' | 'unavailable' | 'upstream',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export const ERROR_STATUS: Record<ContactsError['code'], number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  /** No company AI provider for "Tell me about them". */
  unavailable: 503,
  /** The AI provider refused, or its answer couldn't be read. */
  upstream: 502,
}
