import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { ReminderActor, ReminderDeps, ReminderView } from '$lib/server/memory/reminders/service'
import { liveMemoryWriterOf, requireWriter, type MemoryWriter } from './assistant-writes'
import { REMINDER_TOOL_NAMES } from './manifest'

/**
 * reminders.* kernel tools (namespace owned by the memory module): a
 * person's own recurring reminders (Contribute 2c414719) — fixed weekdays at
 * a wall time in their time zone. A due occurrence waits under the person's
 * Needs you on the dashboard until ticked off or snoozed; nothing is sent to
 * the chat. Private to the person (RLS): who acts is resolved like Memory
 * writes (assistant-writes.ts) — a person acts as themself, the company
 * assistant for the person it is answering, or the call fails loud. Not
 * approval-gated: the person asked for it in their own chat, and it touches
 * only their own reminders.
 */

export { REMINDER_TOOL_NAMES }

export type ReminderToolDeps = {
  deps?: () => Promise<ReminderDeps>
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
}

const WEEKDAY = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])
const DAY_LABEL: Record<z.infer<typeof WEEKDAY>, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }
const weekdays = z.array(WEEKDAY).min(1).max(7).describe('Weekdays as MO, TU, WE, TH, FR, SA, SU — e.g. ["MO","TH"] for Monday and Thursday.')
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour')
  .describe('Local wall time HH:MM (24-hour) in the reminder’s time zone, e.g. "09:00".')
const timeZone = z.string().min(1).describe("IANA time zone, e.g. Europe/Berlin. Leave out to use the person's own (Settings).")
const reminderId = z.string().min(1).describe('The reminder id (from reminders.list).')

const emptyInput = z.object({}).strict()
const createInput = z
  .object({
    title: z.string().min(1).max(200).describe('What to do, short: "Prepare, check or send LinkedIn posts".'),
    note: z.string().max(2000).optional(),
    weekdays,
    time,
    time_zone: timeZone.optional(),
  })
  .strict()
const updateInput = z
  .object({
    reminder_id: reminderId,
    title: z.string().min(1).max(200).optional(),
    note: z.string().max(2000).optional(),
    weekdays: weekdays.optional(),
    time: time.optional(),
    time_zone: timeZone.optional(),
  })
  .strict()
const idInput = z.object({ reminder_id: reminderId }).strict()
const completeInput = z
  .object({
    reminder_id: reminderId,
    all: z.boolean().optional().describe('Tick off every open occurrence, not only the oldest.'),
  })
  .strict()
const snoozeInput = z
  .object({
    reminder_id: reminderId,
    minutes: z.number().int().min(1).max(30 * 24 * 60).optional().describe('Snooze for this many minutes.'),
    until: z.string().min(1).optional().describe('Or snooze until this ISO 8601 instant (within 30 days).'),
  })
  .strict()

async function liveDeps(): Promise<ReminderDeps> {
  const { reminderDeps } = await import('$lib/server/memory/reminders/live')
  return reminderDeps()
}

const service = () => import('$lib/server/memory/reminders/service')
const view = (out: unknown) => out as ReminderView | undefined
const rhythm = (r: Pick<ReminderView, 'weekdays' | 'time'>) => `${r.weekdays.map((d) => DAY_LABEL[d]).join(', ')} ${r.time}`
const named = (verb: string, fallback: string) => (_input: unknown, output: unknown) => {
  const r = view(output)
  return r ? `${verb} '${r.title}'` : fallback
}

export function createReminderTools(opts: ReminderToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const writerOf = opts.writerOf ?? liveMemoryWriterOf
  const actor = async (ctx: ToolContext): Promise<ReminderActor> => {
    const w = requireWriter(await writerOf(ctx))
    return { userId: w.userId, via: w.kind === 'assistant' ? 'assistant' : 'person' }
  }
  const userOf = async (ctx: ToolContext) => (await actor(ctx)).userId
  // Every member's own reminders (CB3: the brain reaches them as the member).
  const base: Pick<ToolDescriptor, 'module' | 'permission'> = { module: 'memory', permission: { roles: ['admin', 'member', 'agent'] } }

  return [
    {
      ...base,
      name: 'reminders.create',
      summary:
        'Create a recurring reminder for the person you work for: fixed weekdays at a local time (e.g. every Monday and Thursday at 09:00), in their time zone unless given. When one is due it waits under their Needs you on the dashboard until they tick it off or snooze it — it is not a chat message. For a one-off dated task use memory.capture_thought.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof createInput>, output: unknown) => {
        const r = view(output)
        return r ? `Set a reminder '${r.title}' (${rhythm(r)})` : `Set a reminder '${input.title}'`
      },
      inputSchema: createInput,
      handler: async (ctx, input) => {
        const i = createInput.parse(input)
        return (await service()).createReminder(await deps(), await actor(ctx), {
          title: i.title,
          note: i.note,
          weekdays: i.weekdays,
          time: i.time,
          timeZone: i.time_zone,
        })
      },
    },
    {
      ...base,
      name: 'reminders.list',
      summary:
        "List the person's reminders: rhythm, time zone, active or paused, the next occurrence (nextAt), what is due now (due: oldest open occurrence and count) and any running snooze.",
      auditClass: 'read',
      inputSchema: emptyInput,
      handler: async (ctx) => ({ reminders: await (await service()).listReminders(await deps(), await userOf(ctx)) }),
    },
    {
      ...base,
      name: 'reminders.update',
      summary:
        'Change a reminder’s title, note, weekdays, time or time zone. A changed rhythm starts from now (open occurrences of the old rhythm are dropped); a changed title or note keeps what is due.',
      auditClass: 'mutate',
      activity: named('Changed the reminder', 'Changed a reminder'),
      inputSchema: updateInput,
      handler: async (ctx, input) => {
        const i = updateInput.parse(input)
        return (await service()).updateReminder(await deps(), await userOf(ctx), i.reminder_id, {
          title: i.title,
          note: i.note,
          weekdays: i.weekdays,
          time: i.time,
          timeZone: i.time_zone,
        })
      },
    },
    {
      ...base,
      name: 'reminders.pause',
      summary: 'Pause a reminder: no occurrences come due and it leaves Needs you until resumed.',
      auditClass: 'mutate',
      activity: named('Paused the reminder', 'Paused a reminder'),
      inputSchema: idInput,
      handler: async (ctx, input) => (await service()).pauseReminder(await deps(), await userOf(ctx), idInput.parse(input).reminder_id),
    },
    {
      ...base,
      name: 'reminders.resume',
      summary: 'Resume a paused reminder from now on (what fell in the pause is skipped).',
      auditClass: 'mutate',
      activity: named('Resumed the reminder', 'Resumed a reminder'),
      inputSchema: idInput,
      handler: async (ctx, input) => (await service()).resumeReminder(await deps(), await userOf(ctx), idInput.parse(input).reminder_id),
    },
    {
      ...base,
      name: 'reminders.delete',
      summary: 'Delete a reminder for good.',
      auditClass: 'mutate',
      activity: (_input: z.infer<typeof idInput>, output: unknown) => {
        const r = output as { title?: string } | undefined
        return r?.title ? `Deleted the reminder '${r.title}'` : 'Deleted a reminder'
      },
      inputSchema: idInput,
      handler: async (ctx, input) => (await service()).deleteReminder(await deps(), await userOf(ctx), idInput.parse(input).reminder_id),
    },
    {
      ...base,
      name: 'reminders.complete',
      summary: 'Tick off the oldest open occurrence of a due reminder (or every open one with all: true); it leaves Needs you once none is open.',
      auditClass: 'mutate',
      activity: named('Ticked off', 'Ticked off a reminder'),
      inputSchema: completeInput,
      handler: async (ctx, input) => {
        const i = completeInput.parse(input)
        return (await service()).completeReminder(await deps(), await userOf(ctx), i.reminder_id, { all: i.all })
      },
    },
    {
      ...base,
      name: 'reminders.snooze',
      summary: 'Snooze a reminder: hidden from Needs you for some minutes or until an instant (at most 30 days); it comes back with whatever is open then.',
      auditClass: 'mutate',
      activity: named('Snoozed', 'Snoozed a reminder'),
      inputSchema: snoozeInput,
      handler: async (ctx, input) => {
        const i = snoozeInput.parse(input)
        return (await service()).snoozeReminder(await deps(), await userOf(ctx), i.reminder_id, { minutes: i.minutes, until: i.until })
      },
    },
  ]
}
