import { z } from 'zod'

/**
 * eigenInference on the hosted plan (fleet feature `aiUsage`): the hosting pays the provider and
 * invoices the company in EUR — the provider-reported USD × the hosting's markup × the hosting's
 * USD→EUR rate of `rateDay`. ee hands os the three numbers (EE_AI_BILLING_*); Settings → AI usage
 * and settings.my_ai_usage show the invoiced EUR from them. Client-safe.
 *
 * The provider USD is activity_call_log.base_cost_usd of eigenInference calls (provider
 * `platform`), never total_cost_usd: the box's own markup (pricing.ts, 20 % on every row) is
 * not what the hosting invoices, so it never enters this amount.
 */
export const aiBillingSchema = z
  .object({
    currency: z.literal('EUR'),
    /** Invoiced = provider cost × markup (the fleet protocol's bounds: 1–10). */
    markup: z.number().min(1).max(10),
    /** EUR per USD at the hosting's rate of rateDay. */
    usdToEur: z.number().positive().max(10),
    /** The UTC day of the rate, YYYY-MM-DD. */
    rateDay: z.iso.date(),
  })
  .strict()
export type AiBilling = z.infer<typeof aiBillingSchema>

/** Sums and products of 6-place amounts, without float residue. */
const round = (value: number) => Math.round(value * 1e8) / 1e8

/** What the company is invoiced, in EUR, for eigenInference calls the provider reported at `providerUsd`. */
export function invoicedEur(providerUsd: number, billing: AiBilling): number {
  return round(providerUsd * billing.markup * billing.usdToEur)
}

/** EUR the way the app shows AI cost: cents, or four places below one cent. */
export function formatAiEur(eur: number): string {
  if (!Number.isFinite(eur) || eur < 0) throw new Error(`An AI cost must be a non-negative number, got ${eur}`)
  if (eur === 0) return '€0.00'
  if (eur < 0.0001) return '<€0.0001'
  return eur < 0.01 ? `€${eur.toFixed(4)}` : `€${eur.toFixed(2)}`
}

/** How the invoiced amount is made, in one sentence. */
export function billingLine(billing: AiBilling): string {
  return `Invoiced in EUR: provider cost × ${billing.markup}, at 1 USD = ${billing.usdToEur} EUR (rate of ${billing.rateDay}).`
}
