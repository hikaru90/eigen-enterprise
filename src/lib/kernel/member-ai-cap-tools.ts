import type { ToolContext, ToolDescriptor } from './types'
import { z } from 'zod'
import { aiBillingSchema, invoicedEur, type AiBilling } from '../ai-usage/billing'
import { replyCostSchema, type ReplyCost } from '../ai-usage/usage'
import { KernelError } from './errors'

/**
 * The company's per-person daily AI cap (plan/phase-demo-company.md D2, DC3): owner and admins
 * read and set it (settings.member_ai_cap_get / _set; Settings → AI provider is a client of
 * these), and every person reads their own usage today against it (settings.my_ai_usage). The
 * gateway enforces it ($lib/server/llm/member-daily-cap.ts) for role `member`; owner and admins
 * are exempt. Unset (null) = no cap.
 */

export const KERNEL_MEMBER_AI_CAP_TOOL_NAMES = [
  'settings.member_ai_cap_get',
  'settings.member_ai_cap_set',
  'settings.my_ai_usage',
] as const

export const KERNEL_MEMBER_AI_CAP_MODULE_ID = 'kernel'

export const memberAiUsageSchema = z.object({
  /** The caller's company role (null: no such member). */
  role: z.enum(['owner', 'admin', 'member']).nullable(),
  /** The company's cap in USD per member per UTC day; null = no cap. */
  capUsd: z.number().positive().nullable(),
  /** Whether the cap limits the caller (members only, and only when a cap is set). */
  capApplies: z.boolean(),
  /** What the caller's model calls cost today (UTC), from the gateway's cost log. */
  spentUsd: z.number().nonnegative(),
  /** What is left today under the cap; null when the cap does not apply to the caller. */
  remainingUsd: z.number().nonnegative().nullable(),
  /** When today's count starts again: the next midnight UTC (ISO). */
  resetsAt: z.string(),
})
export type MemberAiUsageView = z.infer<typeof memberAiUsageSchema>

/** One reply's cost (settings.my_ai_usage with reply_message_id); null = none recorded for it. */
export const myAiUsageOutputSchema = memberAiUsageSchema.extend({
  reply: replyCostSchema.nullable().optional(),
  /**
   * Hosted with eigenInference only (EE_AI_BILLING_* set): today's eigenInference calls as the
   * provider reported them and what the company is invoiced for them (providerUsd × markup × usdToEur).
   */
  invoiced: z
    .object({ providerUsd: z.number().nonnegative(), invoicedEur: z.number().nonnegative(), billing: aiBillingSchema })
    .optional(),
})
export type MyAiUsageOutput = z.infer<typeof myAiUsageOutputSchema>

const usageInputSchema = z
  .object({
    /** An assistant reply of yours (its chat message id): also return what that reply cost. */
    reply_message_id: z.string().uuid().optional(),
  })
  .strict()

const capSchema = z.object({ capUsd: z.number().positive().nullable() })

const setInputSchema = z
  .object({
    /** USD per member per UTC day (positive), or null to remove the cap. */
    cap_usd: z.number().positive().finite().nullable(),
  })
  .strict()
type SetInput = z.infer<typeof setInputSchema>

/** Server-side reads and writes behind the tools (live: $lib/server/llm/member-daily-cap). */
export type MemberAiCapPort = {
  readCapUsd(): Promise<number | null>
  setCapUsd(value: number | null, actorUserId: string): Promise<void>
  usageToday(userId: string): Promise<MemberAiUsageView>
  /**
   * What one of the person's assistant replies cost: null when no such reply of theirs
   * exists; `usage: null` when the reply has no recorded cost (replies from before costs were kept).
   */
  replyCost(userId: string, messageId: string): Promise<{ usage: ReplyCost | null } | null>
  /** How the hosting invoices eigenInference (EE_AI_BILLING_*); null = self-hosted or no eigenInference. */
  billing(): Promise<AiBilling | null>
  /** The provider-reported USD (base_cost_usd) of the person's eigenInference calls today (UTC). */
  eigenInferenceUsdToday(userId: string): Promise<number>
}

export type MemberAiCapToolDeps = { port: MemberAiCapPort }

function usd(value: number): string {
  return `$${value.toFixed(2)}`
}

/** The person behind the call: themselves, or the brain acting as them. An agent that is no person has none. */
function personOf(ctx: ToolContext): string {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError('no_person', 'AI usage is counted per person; this call names no person')
  }
  return ctx.principal.id
}

/** Billing set: the person's eigenInference today in EUR; otherwise nothing (USD as logged). */
async function invoicedToday(port: MemberAiCapPort, person: string): Promise<Pick<MyAiUsageOutput, 'invoiced'>> {
  const billing = await port.billing()
  if (billing === null) return {}
  const providerUsd = await port.eigenInferenceUsdToday(person)
  return { invoiced: { providerUsd, invoicedEur: invoicedEur(providerUsd, billing), billing } }
}

export function createMemberAiCapTools(deps: MemberAiCapToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'settings.member_ai_cap_get',
      module: KERNEL_MEMBER_AI_CAP_MODULE_ID,
      summary:
        'Read the company’s daily AI cap per member in USD (null = no cap). It limits what the model calls made for one member may cost per UTC day; owner and admins are exempt.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      outputSchema: capSchema,
      permission: { roles: ['admin'] },
      handler: async () => ({ capUsd: await deps.port.readCapUsd() }),
    },
    {
      name: 'settings.member_ai_cap_set',
      module: KERNEL_MEMBER_AI_CAP_MODULE_ID,
      summary:
        'Set the company’s daily AI cap per member: {cap_usd: a positive USD amount per member per UTC day, or null to remove it}. Over it, a member’s model calls are refused until midnight UTC; owner and admins are exempt. Waits for a person’s approval in every approval mode.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      approvalAlways: true,
      activity: (input: SetInput) =>
        input.cap_usd === null
          ? 'Removed the daily AI cap per member'
          : `Set the daily AI cap per member to ${usd(input.cap_usd)}`,
      inputSchema: setInputSchema,
      outputSchema: capSchema,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const { cap_usd } = setInputSchema.parse(input)
        await deps.port.setCapUsd(cap_usd, ctx.principal.id)
        return { capUsd: await deps.port.readCapUsd() }
      },
    },
    {
      name: 'settings.my_ai_usage',
      module: KERNEL_MEMBER_AI_CAP_MODULE_ID,
      summary:
        'Your own AI usage today (UTC): what your model calls cost so far, the company’s daily cap per member, whether it applies to you, what is left and when it resets. With {reply_message_id: an assistant reply of yours} also what that reply cost (reply: {costUsd, tokens, modelCalls}, null when none was recorded). On the hosted plan with eigenInference also invoiced: {providerUsd, invoicedEur, billing} — what today’s eigenInference calls are invoiced in EUR, with the markup and the rate’s day.',
      auditClass: 'read',
      inputSchema: usageInputSchema,
      outputSchema: myAiUsageOutputSchema,
      // Every person reads their own usage (admins hold 'member' too); an agent that is no person has none.
      permission: { roles: ['member'] },
      handler: async (ctx, input) => {
        const { reply_message_id } = usageInputSchema.parse(input ?? {})
        const person = personOf(ctx)
        const today = { ...(await deps.port.usageToday(person)), ...(await invoicedToday(deps.port, person)) }
        if (reply_message_id === undefined) return today
        const reply = await deps.port.replyCost(person, reply_message_id)
        if (!reply) {
          throw new KernelError('invalid_input', `No assistant reply ${reply_message_id} of yours.`)
        }
        return { ...today, reply: reply.usage }
      },
    },
  ]
}
