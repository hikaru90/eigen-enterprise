import type { ToolContext } from './types'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from './approvals'
import { InMemoryEventSink } from './events'
import {
  createNotificationTools,
  KERNEL_NOTIFICATION_TOOL_NAMES,
  type NotificationDevice,
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

const iphone: NotificationDevice = {
  id: 'd1',
  endpointHash: 'abc',
  service: 'web.push.apple.com',
  userAgent: 'iPhone',
  since: '2026-11-01T08:00:00.000Z',
  lastSeen: '2026-11-20T08:00:00.000Z',
}

function setup() {
  const sent: Array<{ userId: string; deviceId?: string }> = []
  const port: NotificationsPort = {
    devices: async () => [{ ...iphone, endpoint: 'https://secret-capability-url' } as NotificationDevice],
    sendTest: async (userId, deviceId) => {
      sent.push({ userId, deviceId })
      return { sent: 1, failed: 0, removed: 0 }
    },
  }
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(), new InMemoryApprovalModeStore('ask')),
    approvalStore: new InMemoryApprovalStore(),
  })
  for (const tool of createNotificationTools({ port })) registry.register(tool)
  return { registry, sent }
}

describe('notification tools', () => {
  it('are exactly notifications.devices and notifications.test', () => {
    const { registry } = setup()
    expect(KERNEL_NOTIFICATION_TOOL_NAMES.map((n) => registry.get(n)?.name)).toEqual([
      'notifications.devices',
      'notifications.test',
    ])
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
})
