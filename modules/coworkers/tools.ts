import { z } from 'zod'
import type { ToolContext, ToolDescriptor, ToolPrincipal } from '$lib/kernel/types'
import { notifyCoworkersChanged } from '$lib/server/coworkers/changes'
import type { NoticeDeps } from '$lib/server/coworkers/notices'
import type { RhythmDeps, RhythmView } from '$lib/server/coworkers/rhythms'
import type { CoworkerRunRow, CoworkerRunStore } from '$lib/server/coworkers/run-store'
import type { CoworkerActor, CoworkerDeps, CoworkerView, OrgChartEntry } from '$lib/server/coworkers/service'
import type { EventSubscriptionDeps } from '$lib/server/coworkers/event-subscriptions'
import { COWORKER_TEMPLATE_IDS, COWORKER_TEMPLATES } from '$lib/server/coworkers/templates'
import { COWORKER_EVENT_KINDS, COWORKER_EVENT_OUTCOMES } from '$lib/server/db/coworker-events.schema'
import { COWORKER_RUN_STATUSES, COWORKER_STOP_REASONS, COWORKER_TRIGGER_KINDS } from '$lib/server/db/coworkers.schema'
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
 * Every co-worker change is announced in process (changes.ts), so the
 * co-worker turns (C3) reload the runtime's agents and their triggers.
 *
 * coworkers.runs (C3) is a co-worker's run log: trigger, thread, who asked,
 * status, cost and timings. Where a turn ran is shown only to a reader who may
 * see that conversation (a DM or private channel they are not in never leaks:
 * its location is hidden).
 *
 * C6, proactive: coworkers.rhythm_* are a co-worker's scheduled check-ins
 * (list for members; create, update, delete and run now for admins), and
 * coworkers.needs_you / coworkers.notice_seen are the reader's own "Needs you"
 * rows for finished rhythm and assignment runs.
 *
 * C7, event reactions: coworkers.event_subscriptions_get/set — which company events (a closed
 * set of kinds) a co-worker notices without being @mentioned, and what became of the events
 * it heard (counted by outcome, skipped ones included). Members read; owner and admins set.
 * Whether an event is the co-worker's is a Jev decision (decisions.log, kind
 * coworkers.event_mine), in shadow: logged, not acted on.
 */

/** The conversations, of `conversationIds`, the reader may see. */
export type RunLocationAccess = (reader: ToolPrincipal, conversationIds: string[]) => Promise<Set<string>>

export type CoworkersToolDeps = {
  deps?: () => Promise<CoworkerDeps>
  actor?: (ctx: ToolContext) => Promise<CoworkerActor>
  runs?: () => Promise<CoworkerRunStore>
  runLocations?: RunLocationAccess
  rhythms?: () => Promise<RhythmDeps>
  notices?: () => Promise<NoticeDeps>
  events?: () => Promise<EventSubscriptionDeps>
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

const runsInput = z.object({ user_id: userId, limit: z.number().int().min(1).max(100).optional() }).strict()
const runEntrySchema = z.object({
  id: z.string(),
  triggerKind: z.enum(COWORKER_TRIGGER_KINDS),
  status: z.enum(COWORKER_RUN_STATUSES),
  stopReason: z.enum(COWORKER_STOP_REASONS).nullable(),
  costUsd: z.number(),
  requestedByUserId: z.string().nullable(),
  conversationId: z.string().nullable(),
  threadRootId: z.string().nullable(),
  triggerMessageId: z.string().nullable(),
  threadUrl: z.string().nullable(),
  taskId: z.string().nullable(),
  taskUrl: z.string().nullable(),
  rhythmId: z.string().nullable(),
  hidden: z.boolean(),
  triggeredAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  error: z.string().nullable(),
})

// --- rhythms and "Needs you" (C6) ---------------------------------------------
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const weekdaysField = z.array(z.enum(WEEKDAY_CODES)).min(1).max(7).describe('Weekdays, RFC 5545 codes: MO TU WE TH FR SA SU.')
const timeField = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM on a 24-hour clock')
  .describe('Wall time HH:MM (24 h) in time_zone.')
const zoneField = z.string().min(1).max(64).describe('IANA time zone, e.g. Europe/Berlin.')
const instructionField = z.string().min(1).max(2000).describe('What to post at each check-in, e.g. "Post the marketing standup: yesterday, today, blockers."')
const conversationField = z.string().uuid().describe('The conversation it posts in (a channel or DM it is a member of; messages.list_channels).')
const rhythmIdField = z.string().uuid()
const rhythmListInput = z.object({ user_id: userId }).strict()
const rhythmCreateInput = z
  .object({
    user_id: userId,
    weekdays: weekdaysField,
    time: timeField,
    time_zone: zoneField,
    instruction: instructionField,
    conversation_id: conversationField,
    enabled: z.boolean().optional(),
  })
  .strict()
const rhythmUpdateInput = z
  .object({
    rhythm_id: rhythmIdField,
    weekdays: weekdaysField.optional(),
    time: timeField.optional(),
    time_zone: zoneField.optional(),
    instruction: instructionField.optional(),
    conversation_id: conversationField.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
const rhythmByIdInput = z.object({ rhythm_id: rhythmIdField }).strict()
const noticeSeenInput = z.object({ run_id: z.string().uuid() }).strict()
export const rhythmViewSchema = z.object({
  id: z.string(),
  coworkerUserId: z.string(),
  weekdays: z.array(z.enum(WEEKDAY_CODES)),
  time: z.string(),
  timeZone: z.string(),
  instruction: z.string(),
  targetConversationId: z.string().nullable(),
  targetTitle: z.string().nullable(),
  hidden: z.boolean(),
  enabled: z.boolean(),
  nextAt: z.string().nullable(),
  lastSlotAt: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

async function liveRhythms(): Promise<RhythmDeps> {
  return (await import('$lib/server/coworkers/rhythm-live')).liveRhythmDeps()
}

async function liveNotices(): Promise<NoticeDeps> {
  return (await import('$lib/server/coworkers/rhythm-live')).liveNoticeDeps()
}

async function liveEvents(): Promise<EventSubscriptionDeps> {
  const [{ liveCoworkerEventStores }, coworkers] = await Promise.all([import('$lib/server/coworkers/db-event-store'), import('$lib/server/coworkers')])
  return { subscriptions: liveCoworkerEventStores, observations: liveCoworkerEventStores, coworkers: { get: coworkers.getCoworker } }
}

const eventSubscriptionsGetInput = z.object({ user_id: userId }).strict()
const eventSubscriptionsSetInput = z
  .object({
    user_id: userId,
    event_kinds: z.array(z.enum(COWORKER_EVENT_KINDS)).max(COWORKER_EVENT_KINDS.length).describe('The event kinds it notices (all others off); [] switches every kind off.'),
  })
  .strict()
const outcomeCounts = z.object(Object.fromEntries(COWORKER_EVENT_OUTCOMES.map((o) => [o, z.number().int()])) as Record<(typeof COWORKER_EVENT_OUTCOMES)[number], z.ZodNumber>)
export const eventSubscriptionsSchema = z.object({
  userId: z.string(),
  kinds: z.array(z.object({ kind: z.enum(COWORKER_EVENT_KINDS), on: z.boolean() })),
  hourlyLimit: z.number().int(),
  lastHour: outcomeCounts,
  lastDay: outcomeCounts,
})

const rhythmLine = (r: Pick<RhythmView, 'weekdays' | 'time' | 'timeZone'>) => `${r.weekdays.join(' ')} ${r.time} ${r.timeZone}`

async function liveRuns(): Promise<CoworkerRunStore> {
  return (await import('$lib/server/coworkers/db-run-store')).liveCoworkerRunStore
}

const liveRunLocations: RunLocationAccess = async (reader, ids) =>
  (await import('$lib/server/coworkers/run-log')).liveRunLocations(reader, ids)

/** A change to the co-workers took effect: tell this process (the turns reload their agents). */
async function announced<T>(change: Promise<T>): Promise<T> {
  const out = await change
  notifyCoworkersChanged()
  return out
}

export function createCoworkersTools(opts: CoworkersToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const actor = opts.actor ?? liveActor
  const runs = opts.runs ?? liveRuns
  const runLocations = opts.runLocations ?? liveRunLocations
  const rhythms = opts.rhythms ?? liveRhythms
  const notices = opts.notices ?? liveNotices
  const events = opts.events ?? liveEvents
  const eventService = () => import('$lib/server/coworkers/event-subscriptions')
  const service = () => import('$lib/server/coworkers/service')
  const rhythmService = () => import('$lib/server/coworkers/rhythms')
  const noticeService = () => import('$lib/server/coworkers/notices')
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
        return announced(
          (await service()).createCoworker(
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
          ),
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
        return announced(
          (await service()).updateCoworker(
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
          ),
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
        announced(
          (await service()).setCoworkerEnabled(await actor(ctx), { userId: byIdInput.parse(input).user_id, enabled: true }, await deps()),
        ),
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
        announced(
          (await service()).setCoworkerEnabled(await actor(ctx), { userId: byIdInput.parse(input).user_id, enabled: false }, await deps()),
        ),
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
      handler: async (ctx, input) =>
        announced((await service()).removeCoworker(await actor(ctx), { userId: byIdInput.parse(input).user_id }, await deps())),
    },
    {
      name: 'coworkers.runs',
      module: COWORKERS_MODULE_ID,
      summary:
        "An AI co-worker's recent turns, newest first (limit, default 20): what triggered it (mention | dm | assignment | rhythm | event), the thread (with a link), who asked, status (queued | running | done | failed | stopped), why it stopped (stop_reason), its cost in USD and its timings. Where a turn ran is hidden for a conversation you may not see.",
      auditClass: 'read',
      inputSchema: runsInput,
      outputSchema: z.object({ runs: z.array(runEntrySchema) }),
      permission: { roles: READ_ROLES },
      handler: async (ctx, input) => {
        const i = runsInput.parse(input)
        // An unknown id answers not_found, like coworkers.get.
        await (await service()).getCoworker((await deps()).store, i.user_id)
        const rows: CoworkerRunRow[] = await (await runs()).listForCoworker(i.user_id, i.limit ?? 20)
        const visible = await runLocations(ctx.principal, rows.flatMap((r) => (r.conversationId ? [r.conversationId] : [])))
        const { runEntry } = await import('$lib/server/coworkers/run-log')
        return { runs: rows.map((r) => runEntry(r, visible, ctx.principal.id)) }
      },
    },
    {
      name: 'coworkers.rhythm_list',
      module: COWORKERS_MODULE_ID,
      summary:
        "An AI co-worker's rhythms (scheduled check-ins): weekdays, time and time zone, the instruction, the conversation it posts in (hidden when you may not see it), whether it is on and when it runs next; and targets: the conversations a new rhythm of it can post in (it is a member, you can see them).",
      auditClass: 'read',
      inputSchema: rhythmListInput,
      outputSchema: z.object({
        rhythms: z.array(rhythmViewSchema),
        targets: z.array(z.object({ id: z.string(), title: z.string(), kind: z.enum(['channel', 'dm']) })),
      }),
      permission: { roles: READ_ROLES },
      handler: async (ctx, input) => {
        const id = rhythmListInput.parse(input).user_id
        const d = await rhythms()
        const svc = await rhythmService()
        return { rhythms: await svc.listRhythms(d, ctx.principal.id, id), targets: await svc.rhythmTargets(d, ctx.principal.id, id) }
      },
    },
    {
      name: 'coworkers.rhythm_create',
      module: COWORKERS_MODULE_ID,
      summary:
        'Give an AI co-worker a rhythm: on these weekdays at this time (time zone), it takes a turn and posts the instruction\'s result as a new message in conversation_id. The co-worker must be a member of that conversation. It always posts (no model decides whether). Owner and admins.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof rhythmCreateInput>) => `Set up a rhythm for an AI co-worker: ${rhythmLine({ weekdays: input.weekdays, time: input.time, timeZone: input.time_zone })}`,
      inputSchema: rhythmCreateInput,
      outputSchema: rhythmViewSchema,
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) => {
        const i = rhythmCreateInput.parse(input)
        return (await rhythmService()).createRhythm(await rhythms(), await actor(ctx), {
          coworkerUserId: i.user_id,
          weekdays: i.weekdays,
          time: i.time,
          timeZone: i.time_zone,
          instruction: i.instruction,
          targetConversationId: i.conversation_id,
          enabled: i.enabled,
        })
      },
    },
    {
      name: 'coworkers.rhythm_update',
      module: COWORKERS_MODULE_ID,
      summary:
        "Change a co-worker's rhythm (only the fields given): weekdays, time, time_zone, instruction, conversation_id (it must be a member), enabled. A new schedule, or switching it back on, starts from now: no missed check-in is posted late.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (_input: z.infer<typeof rhythmUpdateInput>, output: unknown) => {
        const r = output as RhythmView | undefined
        return r ? `Changed an AI co-worker's rhythm: ${rhythmLine(r)}${r.enabled ? '' : ' (off)'}` : "Changed an AI co-worker's rhythm"
      },
      inputSchema: rhythmUpdateInput,
      outputSchema: rhythmViewSchema,
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) => {
        const i = rhythmUpdateInput.parse(input)
        return (await rhythmService()).updateRhythm(await rhythms(), await actor(ctx), {
          id: i.rhythm_id,
          weekdays: i.weekdays,
          time: i.time,
          timeZone: i.time_zone,
          instruction: i.instruction,
          targetConversationId: i.conversation_id,
          enabled: i.enabled,
        })
      },
    },
    {
      name: 'coworkers.rhythm_delete',
      module: COWORKERS_MODULE_ID,
      summary: "Delete a co-worker's rhythm: it posts no more check-ins. Its past runs stay in the run log.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => "Deleted an AI co-worker's rhythm",
      inputSchema: rhythmByIdInput,
      outputSchema: z.object({ id: z.string(), deleted: z.literal(true) }),
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) => (await rhythmService()).deleteRhythm(await rhythms(), await actor(ctx), rhythmByIdInput.parse(input).rhythm_id),
    },
    {
      name: 'coworkers.rhythm_run_now',
      module: COWORKERS_MODULE_ID,
      summary:
        "Run a co-worker's rhythm now, outside its schedule: it takes the turn and posts in the rhythm's conversation; the schedule is unchanged. Returns the queued run (follow it in coworkers.runs).",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => "Ran an AI co-worker's rhythm now",
      inputSchema: rhythmByIdInput,
      outputSchema: z.object({ run: runEntrySchema }),
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) => {
        const run = await (await rhythmService()).runRhythmNow(await rhythms(), await actor(ctx), rhythmByIdInput.parse(input).rhythm_id)
        const visible = await runLocations(ctx.principal, run.conversationId ? [run.conversationId] : [])
        const { runEntry } = await import('$lib/server/coworkers/run-log')
        return { run: runEntry(run, visible, ctx.principal.id) }
      },
    },
    {
      name: 'coworkers.needs_you',
      module: COWORKERS_MODULE_ID,
      summary:
        'Your "Needs you" rows from AI co-workers: their finished or stopped rhythm and assignment runs that you answer for or asked for, newest first, each with its run (status, stop reason, cost) and where to look (href). Acknowledge one with coworkers.notice_seen.',
      auditClass: 'read',
      inputSchema: emptyInput,
      outputSchema: z.object({
        notices: z.array(z.object({ run: runEntrySchema, coworker: z.object({ id: z.string(), name: z.string() }), at: z.string(), href: z.string() })),
      }),
      permission: { roles: READ_ROLES },
      handler: async (ctx) => ({ notices: await (await noticeService()).needsYouNotices(await notices(), ctx.principal.id) }),
    },
    {
      name: 'coworkers.notice_seen',
      module: COWORKERS_MODULE_ID,
      summary: 'Acknowledge one of your "Needs you" rows from an AI co-worker (run_id from coworkers.needs_you): it leaves your Needs you.',
      auditClass: 'mutate',
      activity: () => "Acknowledged an AI co-worker's result",
      inputSchema: noticeSeenInput,
      outputSchema: z.object({ runId: z.string(), seen: z.literal(true) }),
      permission: { roles: READ_ROLES },
      handler: async (ctx, input) => (await noticeService()).markNoticeSeen(await notices(), ctx.principal.id, noticeSeenInput.parse(input).run_id),
    },
    {
      name: 'coworkers.event_subscriptions_get',
      module: COWORKERS_MODULE_ID,
      summary:
        "Which company events an AI co-worker notices without being @mentioned (kinds: channel_message = a person's new message in a channel it is a member of, not mentioning it), each on or off; and what became of the events it heard in the last hour and day, by outcome (observed = Jev decided in shadow, see decisions.log kind coworkers.event_mine; queued = it took an event run; skipped_rate_limit past hourlyLimit decisions an hour; skipped_daily_cap when its daily AI budget was spent; failed).",
      auditClass: 'read',
      inputSchema: eventSubscriptionsGetInput,
      outputSchema: eventSubscriptionsSchema,
      permission: { roles: READ_ROLES },
      handler: async (_ctx, input) => (await eventService()).getEventSubscriptions(await events(), eventSubscriptionsGetInput.parse(input).user_id),
    },
    {
      name: 'coworkers.event_subscriptions_set',
      module: COWORKERS_MODULE_ID,
      summary:
        'Choose which company events an AI co-worker notices without being @mentioned: event_kinds is the full new list (channel_message; [] = none). For each such event Jev decides whether it is the co-worker’s to act on; today that runs in shadow — logged in decisions.log, nothing is acted on. The cost is the co-worker’s. Owner and admins.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof eventSubscriptionsSetInput>) =>
        input.event_kinds.length > 0 ? `Set the events an AI co-worker notices: ${input.event_kinds.join(', ')}` : 'Switched off the events an AI co-worker notices',
      inputSchema: eventSubscriptionsSetInput,
      outputSchema: eventSubscriptionsSchema,
      permission: { roles: ADMIN_ROLES },
      handler: async (ctx, input) => {
        const i = eventSubscriptionsSetInput.parse(input)
        return (await eventService()).setEventSubscriptions(await events(), await actor(ctx), { userId: i.user_id, kinds: i.event_kinds })
      },
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
