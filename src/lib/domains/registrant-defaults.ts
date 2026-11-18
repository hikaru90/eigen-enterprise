/** The registrant form's prefill: what os knows about the company and the person buying. */
export type RegistrantDefaults = {
  firstName: string
  lastName: string
  organization: string
  email: string
}

export const EMPTY_REGISTRANT: RegistrantDefaults = { firstName: '', lastName: '', organization: '', email: '' }
