import type { AiBilling } from '$lib/ai-usage/billing'
import type { AiAmounts } from '$lib/ai-usage/overview'
import type { AiUsagePeriod } from '$lib/ai-usage/view'
import type { CoworkerView } from '$lib/server/coworkers/service'

/** GET /api/coworkers/[id]/profile (wish 7c6db153): the co-worker, the edit path for owner/admins, its usage (wish acdb941e). */
export type CoworkerProfilePayload = {
  coworker: CoworkerView
  canManage: boolean
  /** Owner and admins only; amounts null = no AI calls in the period. */
  usage: { amounts: AiAmounts | null; billing: AiBilling | null; period: AiUsagePeriod } | null
}
