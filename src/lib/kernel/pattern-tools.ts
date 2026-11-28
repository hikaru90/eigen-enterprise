import type { ToolContext, ToolDescriptor } from './types'
import { z } from 'zod'

/**
 * What's happening (wish 75a4e570): the company brain's digest of observable activity —
 * who changed how much in which module, and what recurs over the last 7 days — written as
 * observations, never evaluations. The dashboard card is a client of these tools; the CLI,
 * MCP and the agent reach the same read and refresh.
 *
 * Who reads what: each item is built from one module's tools; a caller gets the items whose
 * module is active and whose every counted tool admits one of the caller's roles. The digest is
 * written once (background tick, or a refresh), never per read.
 */

export const KERNEL_PATTERN_TOOL_NAMES = ['dashboard.patterns', 'dashboard.patterns_refresh'] as const

export const patternViewSchema = z.object({
  digestId: z.string().nullable(),
  createdAt: z.string().nullable(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['activity', 'recurring']),
      personId: z.string(),
      personName: z.string(),
      module: z.string(),
      moduleLabel: z.string(),
      count: z.number().int(),
      days: z.number().int(),
      text: z.string(),
    }),
  ),
})
export type PatternToolView = z.infer<typeof patternViewSchema>

export type PatternsPort = {
  /** The latest digest as a caller with these roles may see it. */
  view(roles: readonly string[]): Promise<PatternToolView>
  /** Writes a new digest now (one model call when anything happened). */
  refresh(): Promise<void>
}

function rolesOf(ctx: ToolContext): readonly string[] {
  return ctx.principal.roles
}

export function createPatternTools(deps: { port: PatternsPort }): ToolDescriptor[] {
  return [
    {
      name: 'dashboard.patterns',
      module: 'kernel',
      summary:
        "What's happening in the company (the dashboard card): the latest digest of who changed how much in which module over the last 7 days, and what recurs (active on 3+ days), as plain observations. Only items built from tools you may run in active modules. Empty items with digestId null: no digest written yet (dashboard.patterns_refresh writes one).",
      auditClass: 'read',
      inputSchema: z.object({}),
      outputSchema: patternViewSchema,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx) => deps.port.view(rolesOf(ctx)),
    },
    {
      name: 'dashboard.patterns_refresh',
      module: 'kernel',
      summary:
        "Write a fresh What's happening digest now from the last 7 days (one AI call when anything happened; the background job also writes one daily). Returns the new digest as you may see it.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => "Refreshed What's happening on the dashboard",
      inputSchema: z.object({}),
      outputSchema: patternViewSchema,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx) => {
        await deps.port.refresh()
        return deps.port.view(rolesOf(ctx))
      },
    },
  ]
}
