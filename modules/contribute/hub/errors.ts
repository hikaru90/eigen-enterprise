/** Hub failures with their HTTP meaning (http.ts maps them). */
export class HubError extends Error {
  constructor(
    readonly code: 'invalid' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited',
    message: string,
  ) {
    super(message)
  }
}

export const HUB_ERROR_STATUS: Record<HubError['code'], number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
}
