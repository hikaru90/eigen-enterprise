import type { EmailPlatform } from './service'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { emailManifest } from '../manifest'
import { EMAIL_PLATFORM_READ_TOOLS, EMAIL_PLATFORM_WRITE_TOOLS } from './tool-names'
import { createEmailPlatformTools } from './tools'

const ctx: ToolContext = { principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] }, requestId: 'r' }

const message = {
  id: '00000000-0000-4000-8000-000000000001',
  toAddress: 'a@x.co',
  fromAddress: 'hello@kindred.test',
  subject: 'Hi',
  source: 'api',
  status: 'delivered',
  error: null,
  html: '<p>SECRET BODY</p>',
  text: 'SECRET BODY',
  createdAt: new Date('2026-11-04T12:00:00Z'),
}

const fake = {
  store: {
    listMessages: async () => [message],
    getMessage: async () => message,
    events: async () => [{ status: 'delivered', occurredAt: new Date('2026-11-04T12:00:05Z'), detail: {} }],
    listSuppressions: async () => [],
  },
  addDomain: async (name: string) => ({ id: 'd1', name, status: 'PENDING', records: [] }),
} as unknown as EmailPlatform

const tools = createEmailPlatformTools({ platform: () => fake })
const tool = (name: string) => tools.find((t) => t.name === name)!

describe('email platform tools', () => {
  it('are all in the manifest; reads are read, changes declare a risk and an activity', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...EMAIL_PLATFORM_READ_TOOLS, ...EMAIL_PLATFORM_WRITE_TOOLS].sort())
    for (const t of tools) expect(emailManifest.tools).toContain(t.name)
    for (const name of EMAIL_PLATFORM_READ_TOOLS) expect(tool(name).auditClass).toBe('read')
    for (const name of EMAIL_PLATFORM_WRITE_TOOLS) {
      const sends = name === 'email.send_template'
      expect(tool(name).auditClass).toBe(sends ? 'external' : 'mutate')
      expect(tool(name).approvalRisk).toBe(sends ? 'external' : 'internal')
      expect(typeof tool(name).activity).toBe('function')
    }
  })

  it('the log tools never return a message body', async () => {
    const list = await tool('email.log_list').handler(ctx, { limit: 5 })
    const one = await tool('email.log_get').handler(ctx, { id: message.id })
    expect(JSON.stringify([list, one])).not.toContain('SECRET BODY')
    expect(one).toMatchObject({ found: true, status: 'delivered', timeline: [{ status: 'delivered' }] })
  })

  it('activity sentences name the address, nothing else', () => {
    expect(tool('email.suppression_add').activity!({ email: 'a@x.co' }, undefined)).toBe('Suppressed a@x.co')
    expect(tool('email.domain_add').activity!({ domain: 'kindred.com' }, undefined)).toBe('Added the sender domain kindred.com')
  })

  it('domain_add returns the DNS records to publish', async () => {
    await expect(tool('email.domain_add').handler(ctx, { domain: 'kindred.com' })).resolves.toMatchObject({ name: 'kindred.com', records: [] })
  })
})
