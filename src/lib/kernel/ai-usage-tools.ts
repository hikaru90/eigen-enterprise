import type { AiBilling } from '../ai-usage/billing'
import type { ToolDescriptor } from './types'
import { z } from 'zod'
import { foldAiUsage, overviewSchema, type AiUsageRow } from '../ai-usage/overview'
import { KernelError } from './errors'

/**
 * The company's AI usage overview (plan/phase-ai-usage-overview.md §4): where the AI money goes,
 * by product and task, principal, model and day. Owner and admins; everyone else has
 * settings.my_ai_usage for their own. Settings → AI usage is a client of this tool.
 */

export const KERNEL_AI_USAGE_TOOL_NAMES = ['settings.ai_usage_overview'] as const

export const KERNEL_AI_USAGE_MODULE_ID = 'kernel'

const inputSchema = z
  .object({
    /** First day included (YYYY-MM-DD, UTC); omitted: from the start. */
    from: z.iso.date().optional(),
    /** Last day included (YYYY-MM-DD, UTC); omitted: up to now. */
    to: z.iso.date().optional(),
  })
  .strict()

/** Server-side read behind the tool (live: $lib/server/ai-usage/store). */
export type AiUsagePort = {
  /** The cost log's LLM rows of the period, grouped by principal, task, model and UTC day. */
  rows(period: { from: string | null; to: string | null }): Promise<AiUsageRow[]>
  /** How the hosting invoices eigenInference (EE_AI_BILLING_*); null = self-hosted or no eigenInference. Throws on a partial set. */
  billing(): Promise<AiBilling | null>
}

export type AiUsageToolDeps = { port: AiUsagePort }

export function createAiUsageTools(deps: AiUsageToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'settings.ai_usage_overview',
      module: KERNEL_AI_USAGE_MODULE_ID,
      summary:
        'Where the company’s AI money went: totals, every AI product with its tasks, every person and AI co-worker with their per-product split, every model, and the spend of each day. Optional {from, to} as YYYY-MM-DD (UTC, both included); without them everything on record. costUsd is the USD the gateway logged. On the hosted plan with eigenInference, billing names the markup and the USD→EUR rate with its day, and every amount also has providerUsd (what the provider reported for the eigenInference calls) and invoicedEur (what the company is invoiced: providerUsd × markup × usdToEur). Owner and admins; for your own usage use settings.my_ai_usage.',
      auditClass: 'read',
      inputSchema,
      outputSchema: overviewSchema,
      permission: { roles: ['admin'] },
      handler: async (_ctx, input) => {
        const { from = null, to = null } = inputSchema.parse(input ?? {})
        if (from !== null && to !== null && from > to) {
          throw new KernelError('invalid_input', `The period ends (${to}) before it starts (${from}).`)
        }
        const [rows, billing] = await Promise.all([deps.port.rows({ from, to }), deps.port.billing()])
        return foldAiUsage(rows, { from, to }, billing)
      },
    },
  ]
}
