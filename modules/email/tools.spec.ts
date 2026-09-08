import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { EMAIL_TOOL_NAMES, emailManifest } from './manifest'
import { createEmailTools } from './tools'

// Hermetic: the lazy private-env path must fail loud on an UNCONFIGURED env
// regardless of the developer machine's .env (placeholders would otherwise
// leak in and turn this into a fetch-against-garbage test).
vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))

const env = {
  OWLERY_API_KEY: 'us_test',
  OWLERY_BASE_URL: 'https://owlery.example',
  OWLERY_EMAIL_FROM: 'hello@eigenmesh.xyz',
  OWLERY_CONTACT_BOOK_ID: 'cb_1',
}

const ctx: ToolContext = {
  principal: { id: 'principal-1', kind: 'agent', roles: ['admin', 'agent'] },
  requestId: 'req-1',
}

function fakeFetch(response: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(response.body), { status: response.status })
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe('emailManifest', () => {
  it('owns the namespaced email tool names', () => {
    expect(emailManifest.id).toBe('email')
    expect(emailManifest.tools).toEqual([...EMAIL_TOOL_NAMES])
    expect(emailManifest.tools.every((name) => name.startsWith('email.'))).toBe(true)
  })
})

describe('createEmailTools', () => {
  const tools = createEmailTools({ env })
  const byName = new Map(tools.map((t) => [t.name, t]))

  it('builds exactly the manifest tools with correct audit classes', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...EMAIL_TOOL_NAMES].sort())
    expect(byName.get('email.send_mail')?.auditClass).toBe('external')
    expect(byName.get('email.add_contact')?.auditClass).toBe('mutate')
    expect(byName.get('email.list_contacts')?.auditClass).toBe('read')
    for (const descriptor of tools) {
      expect(descriptor.module).toBe('email')
      expect(descriptor.permission.roles).toEqual(['admin', 'agent'])
    }
  })

  it('send_mail validates recipients and required body parts', () => {
    const schema = byName.get('email.send_mail')?.inputSchema
    expect(schema?.safeParse({ to: 'nope', subject: 's', html: 'h', text: 't' }).success).toBe(false)
    expect(
      schema?.safeParse({ to: 'a@b.co', subject: 's', html: 'h', text: 't' }).success,
    ).toBe(true)
  })

  it('send_mail posts through the Owlery runner with injected env + fetch', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: { emailId: 'em_1' } })
    const send = createEmailTools({ env, fetchImpl }).find((t) => t.name === 'email.send_mail')
    if (!send) throw new Error('send_mail descriptor missing')

    const input = { to: 'a@b.co', subject: 'Hi', html: '<p>hi</p>', text: 'hi' }
    await expect(send.handler(ctx, input)).resolves.toEqual({ emailId: 'em_1' })
    expect(calls[0].url).toBe('https://owlery.example/api/v1/emails')
    const body = JSON.parse(calls[0].init.body as string)
    expect(body).toMatchObject({ to: 'a@b.co', from: 'hello@eigenmesh.xyz', subject: 'Hi' })
  })

  it('add_contact fails loud when the contact book is not configured', async () => {
    const add = createEmailTools({ env: { OWLERY_API_KEY: 'us_x' } }).find(
      (t) => t.name === 'email.add_contact',
    )
    if (!add) throw new Error('add_contact descriptor missing')
    await expect(add.handler(ctx, { email: 'a@b.co' })).rejects.toThrow(/not configured/)
  })

  it('list_contacts GETs the contact book via the runner', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: { data: [] } })
    const list = createEmailTools({ env, fetchImpl }).find(
      (t) => t.name === 'email.list_contacts',
    )
    if (!list) throw new Error('list_contacts descriptor missing')

    await expect(list.handler(ctx, {})).resolves.toEqual({ data: [] })
    expect(calls[0].url).toBe('https://owlery.example/api/v1/contactBooks/cb_1/contacts')
  })

  it('resolves env lazily from private env when not injected (unconfigured → fail loud)', async () => {
    const send = createEmailTools().find((t) => t.name === 'email.send_mail')
    if (!send) throw new Error('send_mail descriptor missing')
    await expect(
      send.handler(ctx, { to: 'a@b.co', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/not configured/)
  })
})
