/** Inbox failures with their HTTP meaning. `not_found` also covers "not yours to read" (no existence leak). */
export class InboxError extends Error {
  constructor(
    readonly code: 'invalid' | 'taken' | 'not_found' | 'forbidden',
    message: string,
  ) {
    super(message)
    this.name = 'InboxError'
  }
}

export const INBOX_ERROR_STATUS: Record<InboxError['code'], number> = {
  invalid: 400,
  taken: 409,
  forbidden: 403,
  not_found: 404,
}
