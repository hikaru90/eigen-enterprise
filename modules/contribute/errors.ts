/** Contribute failures with their HTTP meaning (http.ts maps them). */
export class ContributeError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'upstream',
    message: string,
  ) {
    super(message)
  }
}

export const ERROR_STATUS: Record<ContributeError['code'], number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  upstream: 502,
}
