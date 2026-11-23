import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { CoworkerActor, CoworkerDeps, CoworkerView, OrgChartEntry } from '$lib/server/coworkers/service'
import { COWORKER_TEMPLATE_IDS, COWORKER_TEMPLATES } from '$lib/server/coworkers/templates'
import { COWORKERS_CREATE_TOOL, COWORKERS_MODULE_ID, COWORKERS_REMOVE_TOOL } from './manifest'

/**
 * coworkers.* and org.* kernel tools (plan/phase-ai-coworkers.md C1): every
 * action on AI co-workers and the org chart is a registry tool, so the ee CLI,
 * the agent and (from C5) the UI reach the same thing.
 *
 * Reads are for every member (people and co-workers: a co-worker needs to know
 * who is who). Writes are the owner's and admins' (or the agent's, with admin
 * rights behind the approval gate); creating and removing a co-worker always
 * waits for a person's yes. A member edits only their own title and
 * accountabilities (org.set_position). A co-worker writes nothing here.
 */

export type CoworkersToolDeps = {
  deps?: () => Promise<CoworkerDeps>
  actor?: (ctx: ToolContext) => Promise<CoworkerActor>
}

const READ_ROLES = ['admin', 'member', 'agent']
const ADMIN_ROLES = ['admin', 'agent']

const userId = z.string().min(1).max(200)
const nameField = z.string().min(1).max(80)
const titleField = z.string().min(1).max(120)
const lensField = z.string().min(1).max(4000)
const accountabilitiesField = z.array(z.string().min(1).max(300)).min(1).max(8)
const modelField = z.string().min(1).max(200)
const capField = z.number().positive().max(1000)

const emptyInput = z.object({}).strict()
const byIdInput = z.object({ user_id: userId }).strict()
const createInput = z
  .object({
    template_id: z.enum(COWORKER_TEMPLATE_IDS).optional(),
    name: nameField.optional(),
    title: titleField.optional(),
    lens: lensField.optional(),
    accountabilities: accountabilitiesField.optional(),
    model_id: modelField.optional(),
    reports_to_user_id: userId.nullable().optional(),
    daily_cap_usd: capField.optional(),
  })
  .strict()
const updateInput = z
  .object({
    user_id: userId,
    name: nameField.optional(),
    title: titleField.optional(),
    lens: lensField.optional(),
    accountabilities: accountabilitiesField.optional(),
    model_id: modelField.optional(),
    reports_to_user_id: userId.nullable().optional(),
    daily_cap_usd: capField.optional(),
  })
  .strict()
const setPositionInput = z
  .object({
    user_id: userId,
    title: titleField.nullable().optional(),
    accountabilities: z.array(z.string().min(1).max(300)).max(8).optional(),
    reports_to_user_id: userId.nullable().optional(),
  })
  .strict()

const accountableSchema = z.object({ id: z.string(), name: z.string(), reason: z.enum(['chain', 'owner']) })
export const coworkerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  slug: z.string(),
  title: z.string().nullable(),
  accountabilities: z.array(z.string()),
  lens: z.string(),
  modelId: z.string(),
  enabled: z.boolean(),
  dailyCapUsd: z.number(),
  templateId: z.string().nullable(),
  reportsToUserId: z.string().nullable(),
  accountableHuman: accountableSchema.nullable(),
  agentId: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  removedAt: z.string().nullable(),
})
export const orgChartEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['human', 'coworker']),
  role: z.enum(['owner', 'admin', 'member']),
  title: z.string().nullable(),
  accountabilities: z.array(z.string()),
  reportsToUserId: z.string().nullable(),
  accountableHuman: accountableSchema.nullable(),
  enabled: z.boolean().nullable(),
})
const templateSchema = z.object({
  id: z.enum(COWORKER_TEMPLATE_IDS),
  title: z.string(),
  accountabilities: z.array(z.string()),
  lens: z.string(),
  suggestedModelId: z.string(),
  suggestedDailyCapUsd: z.number(),
})

async function liveDeps(): Promise<CoworkerDeps> {
  const { coworkerDeps } = await import('$lib/server/coworkers')
  return coworkerDeps()
}

/** A person acts with their stored role; a co-worker as a member; the agent with admin rights (behind the approval gate). */
async function liveActor(ctx: ToolContext): Promise<CoworkerActor> {
  const p = ctx.principal
  if (p.kind === 'coworker') return { id: p.id, role: 'member', kind: 'coworker' }
  if (p.kind === 'human') {
    const { getUserRole } = await import('$lib/server/auth/user-role')
    return { id: p.id, role: await getUserRole(p.id), kind: 'person' }
  }
  return { id: p.id, role: 'admin', kind: 'agent' }
}

const nameOf = (output: unknown): string | undefined => (output as Pick<CoworkerView, 'name'> | undefined)?.name

export function createCoworkersTools(opts: CoworkersToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const actor = opts.actor ?? liveActor
  const service = () => import('$lib/server/coworkers/service')
  return [
    {
      name: 'coworkers.templates',
      module: COWORKERS_MODULE_ID,
      summary:
        'The AI co-worker templates (Marketing Manager, Go-to-Market Manager, Designer, Ops Analyst, Finance Analyst, Customer Success Lead): title, accountabilities, lens (role prompt), suggested model and daily cap. Start coworkers.create from one with template_id.',
      auditClass: 'read',
      inputSchema: emptyInput,
      outputSchema: z.object({ templates: z.array(templateSchema) }),
      permission: { roles: READ_ROLES },
      handler: async () => ({ templates: COWORKER_TEMPLATES.map((t) => ({ ...t, accountabilities: [...t.accountabilities] })) }),
    },
    {
      name: 'coworkers.list',
      module: COWORKERS_MODULE_ID,
      summary:
        "The company's AI co-workers: name, title, accountabilities, lens, model, daily cap, whether it is on, who it reports to and the person it answers to (accountable human).",
      auditClass: 'read',
      inputSchema: emptyInput,
      outputSchema: z.object({ coworkers: z.array(coworkerViewSchema) }),
      permission: { roles: READ_ROLES },
      handler: async () => ({ coworkers: await (await service()).listCoworkers((await deps()).store) }),
    },
    {
      name: 'coworkers.get',
      module: COWORKERS_MODULE_ID,
      summary: 'One AI co-worker by user id (from coworkers.list or org.chart), a removed one included.',
      auditClass: 'read',
      inputSchema: byIdInput,
      outputSchema: coworkerViewSchema,
      permission: { roles: READ_ROLES },
      handler: async (_ctx, input) => (await service()).getCoworker((await deps()).store, byIdInput.parse(input).user_id),
    },
    {
      name: COWORKERS_CREATE_TOOL,
      module: COWORKERS_MODULE_ID,
      summary:
        'Create an AI co-worker: from template_id (coworkers.templates), with any field overridden, or from explicit name/title/lens/accountabilities/model_id/daily_cap_usd. model_id must be a chat model of the vetted pool. Optional reports_to_user_id places it in the org chart (default: answers to the owner). It joins as a member and never signs in. Waits for a person’s approval in every approval mode.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      approvalAlways: true,
      activity: (input: z.infer<typeof createInput>, output: unknown) =>
        `Created the AI co-worker ${nameOf(output) ?? input.name ?? input.title ?? input.template_id ?? ''}`.trim(),
      inputSchema: createInput,
      outputSchema: coworkerViewSchema,
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) => {
        const i = createInput.parse(input)
        return (await service()).createCoworker(
          await actor(ctx),
          {
            templateId: i.template_id,
            name: i.name,
            title: i.title,
            lens: i.lens,
            accountabilities: i.accountabilities,
            modelId: i.model_id,
            reportsToUserId: i.reports_to_user_id,
            dailyCapUsd: i.daily_cap_usd,
          },
          await deps(),
        )
      },
    },
    {
      name: 'coworkers.update',
      module: COWORKERS_MODULE_ID,
      summary:
        "Change an AI co-worker (only the fields given): name, title, lens, accountabilities, model_id (a chat model of the vetted pool), daily_cap_usd, reports_to_user_id (null = answers to the owner). Refuses a reporting cycle.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (_input: z.infer<typeof updateInput>, output: unknown) => `Changed the AI co-worker ${nameOf(output) ?? ''}`.trim(),
      inputSchema: updateInput,
      outputSchema: coworkerViewSchema,
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) => {
        const i = updateInput.parse(input)
        return (await service()).updateCoworker(
          await actor(ctx),
          {
            userId: i.user_id,
            name: i.name,
            title: i.title,
            lens: i.lens,
            accountabilities: i.accountabilities,
            modelId: i.model_id,
            reportsToUserId: i.reports_to_user_id,
            dailyCapUsd: i.daily_cap_usd,
          },
          await deps(),
        )
      },
    },
    {
      name: 'coworkers.enable',
      module: COWORKERS_MODULE_ID,
      summary: 'Switch an AI co-worker on: it works again (answers, acts on its rhythm).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (_input: z.infer<typeof byIdInput>, output: unknown) => `Switched on the AI co-worker ${nameOf(output) ?? ''}`.trim(),
      inputSchema: byIdInput,
      outputSchema: coworkerViewSchema,
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) =>
        (await service()).setCoworkerEnabled(await actor(ctx), { userId: byIdInput.parse(input).user_id, enabled: true }, await deps()),
    },
    {
      name: 'coworkers.disable',
      module: COWORKERS_MODULE_ID,
      summary: 'Switch an AI co-worker off: it does nothing until switched on again. Nothing is deleted.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (_input: z.infer<typeof byIdInput>, output: unknown) => `Switched off the AI co-worker ${nameOf(output) ?? ''}`.trim(),
      inputSchema: byIdInput,
      outputSchema: coworkerViewSchema,
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) =>
        (await service()).setCoworkerEnabled(await actor(ctx), { userId: byIdInput.parse(input).user_id, enabled: false }, await deps()),
    },
    {
      name: COWORKERS_REMOVE_TOOL,
      module: COWORKERS_MODULE_ID,
      summary:
        'Remove an AI co-worker for good: it is switched off and leaves the members and the org chart; whoever reported to it reports to its manager. Everything it wrote stays (its messages, thoughts and costs keep their author). Waits for a person’s approval in every approval mode.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      approvalAlways: true,
      activity: (_input: z.infer<typeof byIdInput>, output: unknown) => `Removed the AI co-worker ${nameOf(output) ?? ''}`.trim(),
      inputSchema: byIdInput,
      outputSchema: coworkerViewSchema,
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) => (await service()).removeCoworker(await actor(ctx), { userId: byIdInput.parse(input).user_id }, await deps()),
    },
    {
      name: 'org.chart',
      module: COWORKERS_MODULE_ID,
      summary:
        "The company's org chart: every member and AI co-worker with kind (human | coworker), role, title, accountabilities, who they report to, and for co-workers the person they answer to (nearest human up the chain, else the owner).",
      auditClass: 'read',
      inputSchema: emptyInput,
      outputSchema: z.object({ people: z.array(orgChartEntrySchema) }),
      permission: { roles: READ_ROLES },
      handler: async () => (await service()).orgChart((await deps()).store),
    },
    {
      name: 'org.set_position',
      module: COWORKERS_MODULE_ID,
      summary:
        "Set a seat in the org chart: title (null clears it), accountabilities (the full new list), reports_to_user_id (null = reports to nobody). Owner and admins set anyone's; a member sets only their own title and accountabilities. Refuses self-reporting and reporting cycles.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof setPositionInput>, output: unknown) =>
        `Changed the org chart seat of ${(output as OrgChartEntry | undefined)?.name ?? input.user_id}`,
      inputSchema: setPositionInput,
      outputSchema: orgChartEntrySchema,
      permission: { roles: READ_ROLES },
      handler: async (ctx, input) => {
        const i = setPositionInput.parse(input)
        return (await service()).setOrgPosition(
          await actor(ctx),
          { userId: i.user_id, title: i.title, accountabilities: i.accountabilities, reportsToUserId: i.reports_to_user_id },
          await deps(),
        )
      },
    },
  ]
}
