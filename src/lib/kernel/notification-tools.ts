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

export const KERNEL_NOTIFICATION_TOOL_NAMES = ['notifications.devices', 'notifications.test'] as const

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

export type NotificationsPort = {
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
  ]
}
