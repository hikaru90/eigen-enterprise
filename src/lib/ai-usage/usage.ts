import { z } from 'zod'
import type { MemberAiUsageView } from '$lib/kernel/member-ai-cap-tools'

/**
 * AI budget transparency (proposal 30a8d920): what one assistant reply cost, and a person's
 * usage today against the company's daily cap per member. Client-safe; the amounts are the
 * gateway's own cost log (activity_call_log, USD — the currency the cap and the log use).
 * Observation only: amounts and counts, never an evaluation of the person.
 */

/** What one reply cost: the model calls made while answering it (one trace). */
export const replyCostSchema = z.object({
  /** USD, what the company is billed for those calls (activity_call_log.total_cost_usd). */
  costUsd: z.number().nonnegative(),
  /** Prompt + completion tokens of those calls, as the gateway reported them. */
  tokens: z.number().int().nonnegative(),
  /** How many model calls the reply took (failed attempts included). */
  modelCalls: z.number().int().nonnegative(),
})
export type ReplyCost = z.infer<typeof replyCostSchema>

/** The share of the cap from which the meter shows the red zone. */
export const NEAR_CAP_SHARE = 0.8

/** USD the way the app shows AI cost: cents, or four places below one cent. */
export function formatAiUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`An AI cost must be a non-negative number, got ${usd}`)
  if (usd === 0) return '$0.00'
  if (usd < 0.0001) return '<$0.0001'
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

/** Tokens briefly: 850 tokens · 1.2k tokens · 3.4M tokens. */
export function formatTokens(tokens: number): string {
  const short = (n: number) => n.toFixed(1).replace(/\.0$/, '')
  if (tokens < 1000) return tokens === 1 ? '1 token' : `${tokens} tokens`
  if (tokens < 1_000_000) return `${short(tokens / 1000)}k tokens`
  return `${short(tokens / 1_000_000)}M tokens`
}

/** The reply's cost line: "$0.0042 · 1.2k tokens" (tokens left out when none were reported). */
export function replyCostLine(cost: ReplyCost): string {
  const usd = formatAiUsd(cost.costUsd)
  return cost.tokens > 0 ? `${usd} · ${formatTokens(cost.tokens)}` : usd
}

/** A person's usage today, as settings.my_ai_usage returns it. */
export type AiUsageToday = MemberAiUsageView

export type UsageMeter =
  | { kind: 'capped'; share: number; zone: 'ok' | 'near' | 'over'; spent: string; cap: string; left: string }
  | { kind: 'no_cap'; spent: string }
  | { kind: 'exempt'; spent: string; cap: string }

/** The meter for a person: their share of the cap (red zone from 80 %), no cap, or exempt. */
export function usageMeter(usage: AiUsageToday): UsageMeter {
  const spent = formatAiUsd(usage.spentUsd)
  if (usage.capUsd === null) return { kind: 'no_cap', spent }
  const cap = formatAiUsd(usage.capUsd)
  if (!usage.capApplies) return { kind: 'exempt', spent, cap }
  const share = Math.min(1, usage.spentUsd / usage.capUsd)
  const zone = usage.spentUsd >= usage.capUsd ? 'over' : share >= NEAR_CAP_SHARE ? 'near' : 'ok'
  return { kind: 'capped', share, zone, spent, cap, left: formatAiUsd(usage.remainingUsd ?? 0) }
}

/** The meter in one plain sentence (screen readers, titles). */
export function usageSentence(meter: UsageMeter): string {
  switch (meter.kind) {
    case 'no_cap':
      return `Your AI use today: ${meter.spent}. The company has no daily cap.`
    case 'exempt':
      return `Your AI use today: ${meter.spent}. Owners and admins have no daily cap (members: ${meter.cap}).`
    case 'capped':
      return meter.zone === 'over'
        ? `Your AI use today: ${meter.spent} of ${meter.cap}. The daily cap is reached until midnight UTC.`
        : `Your AI use today: ${meter.spent} of ${meter.cap} (${meter.left} left until midnight UTC).`
  }
}
