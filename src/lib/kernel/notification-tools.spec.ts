import type { ToolContext } from './types'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from './approvals'
import { InMemoryEventSink } from './events'
import {
  createNotificationTools,
  KERNEL_NOTIFICATION_TOOL_NAMES,
  type NotificationDevice,
  type NotificationSettings,
  type NotificationsPort,
} from './notification-tools'
import { delegatedPrincipal } from './principals'
import { KernelRegistry } from './registry'

const person: ToolContext = { principal: { id: 'u1', kind: 'human', roles: ['member'] }, requestId: 'r1' }
const viaBrain: ToolContext = {
  principal: delegatedPrincipal({ id: 'u1', roles: ['member'] }, 'orchestrator'),
  requestId: 'r2',
}
const bareAgent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }, requestId: 'r3' }

const settings: NotificationSettings = {
  timezoneOffsetMinutes: 60,
  eventNotificationsEnabled: true,
  eventReminderLeadMinutes: 10,
  dailySummaryEnabled: false,
  dailySummaryTimeLocal: '08:00',
}

const iphone: NotificationDevice = {
  id: 'd1',
  endpointHash: 'abc',
  service: 'web.push.apple.com',
  userAgent: 'iPhone',
  since: '2026-11-01T08:00:00.000Z',
  lastSeen: '2026-11-20T08:00:00.000Z',
}

const inboxItem = {
  key: 'question:q1',
  kind: 'question' as const,
  title: 'Ony asks',
  detail: 'Van key?',
  href: '/m/memory/questions',
  at: '2026-11-27T10:00:00.000Z',
  unread: true,
}

function setup() {
  const sent: Array<{ userId: string; deviceId?: string }> = []
  const saved: Array<{ userId: string; input: NotificationSettings }> = []
  const marked: Array<{ userId: string; keys: string[] }> = []
  const port: NotificationsPort = {
    devices: async () => [{ ...iphone, endpoint: 'https://secret-capability-url' } as NotificationDevice],
    sendTest: async (userId, deviceId) => {
      sent.push({ userId, deviceId })
      return { sent: 1, failed: 0, removed: 0 }
    },
    loadSettings: async () => settings,
    saveSettings: async (userId, input) => {
      saved.push({ userId, input })
      return { ...input, message: 'Saved.' }
    },
    inbox: async () => ({ items: [inboxItem], unread: 1 }),
    markRead: async (userId, keys) => {
      marked.push({ userId, keys })
      return { items: [{ ...inboxItem, unread: false }], unread: 0 }
    },
  }
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(), new InMemoryApprovalModeStore('ask')),
    approvalStore: new InMemoryApprovalStore(),
  })
  for (const tool of createNotificationTools({ port })) registry.register(tool)
  return { registry, sent, saved, marked }
}

describe('notification tools', () => {
  it('are exactly notifications.devices, .test, .settings_get, .settings_set, .inbox and .mark_read', () => {
    const { registry } = setup()
    expect(KERNEL_NOTIFICATION_TOOL_NAMES.map((n) => registry.get(n)?.name)).toEqual([
      'notifications.devices',
      'notifications.test',
      'notifications.settings_get',
      'notifications.settings_set',
      'notifications.inbox',
      'notifications.mark_read',
    ])
  })

  it('reads the person’s own inbox (the bell) and marks items read, as them', async () => {
    const { registry, marked } = setup()
    expect(await registry.execute('notifications.inbox', {}, viaBrain)).toEqual({ items: [inboxItem], unread: 1 })
    const out = await registry.execute('notifications.mark_read', { keys: ['question:q1'] }, person)
    expect(marked).toEqual([{ userId: 'u1', keys: ['question:q1'] }])
    expect(out).toMatchObject({ unread: 0 })
    await expect(registry.execute('notifications.mark_read', { keys: [] }, person)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(registry.execute('notifications.inbox', {}, bareAgent)).rejects.toThrow(/person/)
  })

  it('lists the person’s own devices, never an endpoint', async () => {
    const { registry } = setup()
    const out = (await registry.execute('notifications.devices', {}, viaBrain)) as { devices: unknown[] }
    expect(out.devices).toEqual([iphone])
    expect(JSON.stringify(out)).not.toContain('secret-capability-url')
  })

  it('sends a test notification to the person’s devices, or one of them', async () => {
    const { registry, sent } = setup()
    await registry.execute('notifications.test', {}, person)
    await registry.execute('notifications.test', { deviceId: 'd1' }, viaBrain)
    expect(sent).toEqual([{ userId: 'u1' }, { userId: 'u1', deviceId: 'd1' }])
  })

  it('fails loud for a principal that is no person (whose devices?)', async () => {
    const { registry } = setup()
    await expect(registry.execute('notifications.devices', {}, bareAgent)).rejects.toThrow(/person/)
  })

  it('reads and saves the person’s own notification settings (the settings pages’ save)', async () => {
    const { registry, saved } = setup()
    expect(await registry.execute('notifications.settings_get', {}, viaBrain)).toEqual(settings)
    const input = { ...settings, dailySummaryEnabled: true, dailySummaryTimeLocal: '07:30' }
    const out = await registry.execute('notifications.settings_set', input, person)
    expect(saved).toEqual([{ userId: 'u1', input }])
    expect(out).toMatchObject({ dailySummaryTimeLocal: '07:30', message: 'Saved.' })
  })

  it('refuses a reminder lead under one minute or a bad time before saving', async () => {
    const { registry, saved } = setup()
    for (const bad of [{ eventReminderLeadMinutes: 0 }, { dailySummaryTimeLocal: 'eight' }]) {
      await expect(registry.execute('notifications.settings_set', { ...settings, ...bad }, person)).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
    expect(saved).toHaveLength(0)
    await expect(registry.execute('notifications.settings_get', {}, bareAgent)).rejects.toThrow(/person/)
  })
})
