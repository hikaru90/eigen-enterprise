/** Contacts failures with their HTTP meaning (http.ts maps them). */
export class ContactsError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden',
    message: string,
  ) {
    super(message)
  }
}

export const ERROR_STATUS: Record<ContactsError['code'], number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
}
