/** Calendar failures with their HTTP meaning (http.ts maps them). */
export class CalendarError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export const ERROR_STATUS: Record<CalendarError['code'], number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
}
