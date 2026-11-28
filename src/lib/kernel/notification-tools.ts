import type { ToolContext, ToolDescriptor } from './types'
import { z } from 'zod'

/**
 * A person's notification devices (bug 87f5b9f8): which of their devices have
 * notifications on, and a test notification to all of them or one — the same
 * effect as Settings → Account → Notifications, so the agent can answer "why
 * don't I get notifications on my phone?" with facts and a test. Always the
 * calling person's own devices: there is no input naming someone else.
 *
 * The output schema names no endpoint and no keys (an endpoint is a capability
 * URL), so the registry strips them should a port let one slip.
 */

export const KERNEL_NOTIFICATION_TOOL_NAMES = [
  'notifications.devices',
  'notifications.test',
  'notifications.settings_get',
  'notifications.settings_set',
  'notifications.inbox',
  'notifications.mark_read',
] as const

const deviceSchema = z.object({
  id: z.string(),
  endpointHash: z.string(),
  service: z.string(),
  userAgent: z.string().nullable(),
  since: z.string(),
  lastSeen: z.string(),
})
export type NotificationDevice = z.infer<typeof deviceSchema>

const testResultSchema = z.object({ sent: z.number(), failed: z.number(), removed: z.number() })
export type TestNotificationResult = z.infer<typeof testResultSchema>

/** A person's own notification settings (Settings → Notifications, /m/memory/settings). */
const settingsSchema = z.object({
  timezoneOffsetMinutes: z.number(),
  eventNotificationsEnabled: z.boolean(),
  eventReminderLeadMinutes: z.number(),
  dailySummaryEnabled: z.boolean(),
  dailySummaryTimeLocal: z.string(),
})
export type NotificationSettings = z.infer<typeof settingsSchema>

const settingsSetInput = z
  .object({
    timezoneOffsetMinutes: z.number().int(),
    eventNotificationsEnabled: z.boolean(),
    eventReminderLeadMinutes: z.number().int().min(1),
    dailySummaryEnabled: z.boolean(),
    dailySummaryTimeLocal: z.string().regex(/^\d{1,2}:\d{2}$/),
  })
  .strict()

/** One item of a person's inbox (src/lib/server/notifications/inbox.ts). */
const inboxItemSchema = z.object({
  key: z.string(),
  kind: z.enum(['question', 'task', 'task_update', 'coworker']),
  title: z.string(),
  detail: z.string(),
  href: z.string(),
  at: z.string(),
  unread: z.boolean(),
})
/** A mention of the person in Messages: a channel message or thread reply that @named them (additive, 0205). */
const mentionItemSchema = inboxItemSchema.extend({ kind: z.literal('mention') })
const inboxSchema = z.object({ items: z.array(inboxItemSchema), mentions: z.array(mentionItemSchema), unread: z.number() })
export type InboxView = z.infer<typeof inboxSchema>
const markReadInput = z
  .object({ keys: z.array(z.string().min(1)).min(1).max(200).describe('Item keys from notifications.inbox.') })
  .strict()

export type NotificationsPort = {
  /** The person's inbox: what needs them, newest first, each read or unread. */
  inbox(userId: string): Promise<InboxView>
  /** Marks items of their own inbox read; fails loud on a key not in it. */
  markRead(userId: string, keys: string[]): Promise<InboxView>
  loadSettings(userId: string): Promise<NotificationSettings>
  /** Saves exactly as the settings pages do (the same parse and save); fails loud on a bad value. */
  saveSettings(userId: string, input: NotificationSettings): Promise<NotificationSettings & { message: string }>
  devices(userId: string): Promise<NotificationDevice[]>
  /** Fails loud when nothing could be delivered (no device, or every push service refused). */
  sendTest(userId: string, deviceId?: string): Promise<TestNotificationResult>
}

function personOf(ctx: ToolContext): string {
  if (ctx.principal.kind !== 'human') {
    throw new Error('Notification devices belong to a person; this call runs as no person')
  }
  return ctx.principal.id
}

export function createNotificationTools(deps: { port: NotificationsPort }): ToolDescriptor[] {
  return [
    {
      name: 'notifications.devices',
      module: 'kernel',
      summary:
        'The devices on which you (the person this call acts for) have notifications turned on: push service, browser/user agent, since when, last seen. A phone not listed gets no notifications: open the installed app on it and turn notifications on there (iPhone/iPad: only the home-screen app gets them).',
      auditClass: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ devices: z.array(deviceSchema) }),
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx) => ({ devices: await deps.port.devices(personOf(ctx)) }),
    },
    {
      name: 'notifications.test',
      module: 'kernel',
      summary:
        'Send a test notification to your own devices — all of them, or one by its id from notifications.devices. Reports how many devices got it; fails when none could.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { deviceId?: string }) =>
        input.deviceId ? 'Sent a test notification to one of my devices' : 'Sent a test notification to my devices',
      inputSchema: z.object({ deviceId: z.string().min(1).optional() }),
      outputSchema: testResultSchema,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx, input) => {
        const { deviceId } = input as { deviceId?: string }
        return deps.port.sendTest(personOf(ctx), deviceId)
      },
    },
    {
      name: 'notifications.settings_get',
      module: 'kernel',
      summary:
        'Your own notification settings: time zone offset (minutes), event reminders on/off and how many minutes before, the daily summary on/off and its local time (HH:MM).',
      auditClass: 'read',
      inputSchema: z.object({}),
      outputSchema: settingsSchema,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx) => deps.port.loadSettings(personOf(ctx)),
    },
    {
      name: 'notifications.settings_set',
      module: 'kernel',
      summary:
        'Save your own notification settings (all five fields, as notifications.settings_get returns them): the same save as Settings → Notifications. The time zone snaps to the nearest offered offset; the reminder lead is at least 1 minute.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Changed my notification settings',
      inputSchema: settingsSetInput,
      outputSchema: settingsSchema.extend({ message: z.string() }),
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx, input) => deps.port.saveSettings(personOf(ctx), settingsSetInput.parse(input)),
    },
    {
      name: 'notifications.inbox',
      module: 'kernel',
      summary:
        'Your inbox (the bell in the top bar): what needs you, newest first — team questions asked of you that you have not answered (kind question), tasks given to you (task), news on tasks you gave out (task_update), and your AI co-workers\' finished results (coworker); in a separate list `mentions`, the channel messages and thread replies that @mentioned you (kind mention, href opens the conversation or thread); each with where to open it (href) and whether you have read it, plus the unread count. An item leaves when its source is done (question answered, task done, result acknowledged); mark it read with notifications.mark_read.',
      auditClass: 'read',
      inputSchema: z.object({}),
      outputSchema: inboxSchema,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx) => deps.port.inbox(personOf(ctx)),
    },
    {
      name: 'notifications.mark_read',
      module: 'kernel',
      summary: 'Mark items of your own inbox read (keys from notifications.inbox): they stay until done but no longer count as unread. Returns the inbox.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { keys: string[] }) => (input.keys.length === 1 ? 'Marked a notification read' : `Marked ${input.keys.length} notifications read`),
      inputSchema: markReadInput,
      outputSchema: inboxSchema,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx, input) => deps.port.markRead(personOf(ctx), markReadInput.parse(input).keys),
    },
  ]
}
