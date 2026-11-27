import { aiBillingSchema, type AiBilling } from '$lib/ai-usage/billing'
import { env } from '$lib/server/env/private-env'

/**
 * How the hosting invoices this company's eigenInference (fleet feature `aiUsage`): ee sets
 * these os secrets from desired.aiUsage (ee/src/fleet/agent.ts AI_BILLING_SECRETS); all three
 * or none. None = self-hosted or no eigenInference: AI usage stays in USD as logged. A partial
 * or malformed set fails loud — never shown as if it were no billing.
 */
export const AI_BILLING_ENV = {
  markup: 'EE_AI_BILLING_MARKUP',
  usdToEur: 'EE_AI_BILLING_USD_TO_EUR',
  rateDay: 'EE_AI_BILLING_RATE_DAY',
} as const

export function readAiBilling(source: Record<string, string | undefined>): AiBilling | null {
  const entries = Object.entries(AI_BILLING_ENV) as [keyof typeof AI_BILLING_ENV, string][]
  const values = entries.map(([key, name]) => [key, name, source[name]?.trim() ?? ''] as const)
  const missing = values.filter(([, , v]) => v === '').map(([, name]) => name)
  if (missing.length === entries.length) return null
  if (missing.length > 0) {
    throw new Error(
      `The eigenInference billing is only partly configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set (all three EE_AI_BILLING_* or none).`,
    )
  }
  const raw = Object.fromEntries(values.map(([key, , v]) => [key, v])) as Record<keyof typeof AI_BILLING_ENV, string>
  const parsed = aiBillingSchema.safeParse({
    currency: 'EUR',
    markup: Number(raw.markup),
    usdToEur: Number(raw.usdToEur),
    rateDay: raw.rateDay,
  })
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => AI_BILLING_ENV[i.path[0] as keyof typeof AI_BILLING_ENV]))]
    throw new Error(`The eigenInference billing is malformed: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} out of range or not a number/date.`)
  }
  return parsed.data
}

/** This process's eigenInference billing (EE_AI_BILLING_*), or null. Throws on a partial or malformed set. */
export function aiBillingFromEnv(): AiBilling | null {
  return readAiBilling(env as Record<string, string | undefined>)
}
