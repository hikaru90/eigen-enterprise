import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import type { SendMailInput } from '$lib/server/mail/company-mail'
import { EMAIL_TOOL_NAMES, emailManifest } from './manifest'
import { createEmailTools } from './tools'

/** Company email lives in the database; in unit tests it is not set up. */
vi.mock('$lib/server/mail', async () => {
  const { MailNotConfiguredError } = await import('$lib/server/mail/company-mail')
  return {
    companyMail: () => ({
      send: async () => {
        throw new MailNotConfiguredError()
      },
    }),
  }
})

const ctx: ToolContext = {
  principal: { id: 'principal-1', kind: 'agent', roles: ['admin', 'agent'] },
  requestId: 'req-1',
}

describe('emailManifest', () => {
  it('owns the namespaced email tool names', () => {
    expect(emailManifest.id).toBe('email')
    expect(emailManifest.tools).toEqual([...EMAIL_TOOL_NAMES])
  })
})

describe('createEmailTools', () => {
  it('builds exactly the manifest tools', () => {
    const tools = createEmailTools()
    expect(tools.map((t) => t.name)).toEqual([...EMAIL_TOOL_NAMES])
    expect(tools[0]?.auditClass).toBe('external')
  })

  it('send_mail validates recipients and required body parts', () => {
    const schema = createEmailTools()[0]?.inputSchema
    expect(schema?.safeParse({ to: 'nope', subject: 's', html: 'h', text: 't' }).success).toBe(false)
    expect(schema?.safeParse({ to: 'a@b.co', subject: 's', html: 'h', text: 't' }).success).toBe(true)
  })

  it('send_mail goes through the company mail path', async () => {
    const sent: SendMailInput[] = []
    const send = createEmailTools({
      mail: {
        send: async (m) => {
          sent.push(m)
          return { messageId: 'm1' }
        },
      },
    })[0]!
    const input = { to: 'a@b.co', subject: 'Hi', html: '<p>hi</p>', text: 'hi' }
    await expect(send.handler(ctx, input)).resolves.toEqual({ messageId: 'm1' })
    expect(sent).toEqual([input])
  })

  it('resolves company mail lazily when not injected (not set up → fail loud)', async () => {
    const send = createEmailTools()[0]!
    await expect(send.handler(ctx, { to: 'a@b.co', subject: 's', html: 'h', text: 't' })).rejects.toThrow(
      /not configured/,
    )
  })
})
