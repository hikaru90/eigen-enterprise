import { z } from 'zod'

/**
 * The control plane's domains API (plan/managed-domains.md, Contract), shared
 * by os's server (validates what it sends and receives) and the browser
 * components (types, price formatting). Pure: no server imports.
 */

/** One label, tried on every TLD with an operator price: a-z, 0-9 and hyphen, 1–63 characters. */
export const SEARCH_LABEL = /^[a-z0-9-]{1,63}$/

export const DOMAIN_STATES = ['charging', 'registering', 'configuring', 'active', 'failed'] as const
export type DomainState = (typeof DOMAIN_STATES)[number]

/**
 * When os makes a bought domain a mail domain itself (DM5): once it is
 * active. The control plane already makes it one while `configuring` (DKIM
 * needs the SES identity before the domain can turn active), so os's step is
 * a safety net: idempotent, and harmless when the domain is a mail domain.
 */
export const MAIL_READY_STATES: readonly DomainState[] = ['active']

export const searchResultSchema = z.object({
  name: z.string().min(1),
  available: z.boolean(),
  priceCents: z.number().int().nonnegative().nullable(),
  currency: z.literal('EUR'),
})
export type DomainSearchResult = z.infer<typeof searchResultSchema>

export const searchResponseSchema = z.object({ results: z.array(searchResultSchema) })

export const boughtDomainSchema = z.object({
  name: z.string().min(1),
  state: z.enum(DOMAIN_STATES),
  error: z.string().nullable(),
  renewsAt: z.string().nullable(),
  autoRenew: z.boolean(),
})
export type BoughtDomain = z.infer<typeof boughtDomainSchema>

export const domainsResponseSchema = z.object({ domains: z.array(boughtDomainSchema) })

/** Why a purchase was refused with 409: taken meanwhile, or the price changed (priceCents = the current price). */
export const PURCHASE_CONFLICTS = ['taken', 'price_changed'] as const
export const purchaseConflictSchema = z.object({
  error: z.string().min(1),
  reason: z.enum(PURCHASE_CONFLICTS),
  priceCents: z.number().int().nonnegative().nullable(),
})
export type PurchaseConflict = z.infer<typeof purchaseConflictSchema>

export const purchaseResponseSchema = z.object({ name: z.string().min(1), state: z.enum(DOMAIN_STATES) })
export type PurchaseResponse = z.infer<typeof purchaseResponseSchema>

const text = (label: string) => z.string().trim().min(1, `${label} is missing.`)

/** The registrant: the company (DM3: passed through to the registry, not kept by the control plane). */
export const registrantSchema = z
  .object({
    firstName: text('First name'),
    lastName: text('Last name'),
    organization: text('Company name'),
    email: z.string().trim().email('Enter a valid email address for the registrant.'),
    phone: z
      .string()
      .trim()
      .regex(/^\+\d{1,3}\.\d{4,14}$/, 'Enter the phone number with its country code, like +49 and 301234567.'),
    addressLine1: text('Street and number'),
    addressLine2: z.string().trim().optional(),
    city: text('City'),
    postalCode: text('Postal code'),
    countryCode: z.string().regex(/^[A-Z]{2}$/, 'Choose the country.'),
    state: z.string().trim().optional(),
  })
  .strict()
export type Registrant = z.infer<typeof registrantSchema>

export const purchaseRequestSchema = z
  .object({
    name: z.string().trim().toLowerCase().min(3),
    acceptedPriceCents: z.number().int().nonnegative(),
    registrant: registrantSchema,
  })
  .strict()
export type PurchaseRequest = z.infer<typeof purchaseRequestSchema>

/**
 * The registry's phone format, "+49.301234567": the calling code, a dot, the
 * number as dialled from abroad. Spaces, dashes, slashes, dots and brackets
 * in what the person typed are dropped; anything else is left for the schema
 * to refuse.
 */
export function registryPhone(callingCode: string, number: string): string {
  const code = callingCode.trim().replace(/^\+?/, '+')
  const digits = number.replace(/[\s\-/().]/g, '')
  return `${code}.${digits}`
}

/** "€12.00" — prices are whole cents in EUR. */
export function formatEur(cents: number): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}

/** What the company is told about each state, in plain words. */
export const STATE_LABEL: Record<DomainState, string> = {
  charging: 'Paying',
  registering: 'Registering',
  configuring: 'Setting up DNS and email',
  active: 'Ready',
  failed: 'Failed',
}
