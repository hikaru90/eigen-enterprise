import type { EmailPlatform } from './service'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { createEmailManageTools, LIST_IMPORT_MAX_CHARS, type EmailManageToolDeps } from './manage-tools'
import { EMAIL_PLATFORM_DESTRUCTIVE_TOOLS } from './tool-names'

const human: ToolContext = { principal: { id: 'user-1', kind: 'human', roles: ['admin'] }, requestId: 'r' }
const agent: ToolContext = { principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] }, requestId: 'r' }
const ID = '00000000-0000-4000-8000-000000000001'

function setup(over: Partial<EmailManageToolDeps> & { mode?: 'own' | 'managed' } = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const rec = (name: string, ret: unknown = {}) => async (...args: unknown[]) => {
    calls.push([name, ...args])
    return ret
  }
  const fake = {
    deleteDomain: rec('deleteDomain'),
    setDomainReceiving: rec('setDomainReceiving', { domain: { receiving: true }, receivingError: null }),
    setDomainTracking: rec('setDomainTracking', { tracking: false }),
    setupReceiving: rec('setupReceiving', { receivingStatus: 'ready' }),
    listDomains: async () => [{ name: 'kindred.test', sendable: true }],
    setDefaultSender: rec('setDefaultSender'),
    deleteSender: rec('deleteSender'),
    store: {
      getSenderByAddress: async (a: string) => (a === 'hi@kindred.test' ? { id: 's1', address: a } : null),
    },
    owlery: {
      mode: async () => over.mode ?? 'own',
      setupEvents: rec('setupEvents', { eventsStatus: 'ready' }),
      setDefaultSender: rec('owlery.setDefaultSender'),
    },
    templates: {
      createLayout: rec('createLayout', { id: 'l1' }),
      updateLayout: rec('updateLayout'),
      deleteLayout: rec('deleteLayout'),
      createTemplate: rec('createTemplate', { id: 't1' }),
      updateTemplate: rec('updateTemplate'),
      deleteTemplate: rec('deleteTemplate'),
      sendTest: rec('sendTest', { status: 'queued' }),
    },
    audience: {
      createFlow: rec('createFlow', { id: 'f1' }),
      updateFlow: rec('updateFlow'),
      setFlowStatus: rec('setFlowStatus', { status: 'active' }),
      deleteFlow: rec('deleteFlow'),
      createList: rec('createList', { id: 'c1' }),
      updateList: rec('updateList'),
      deleteList: rec('deleteList'),
      importContacts: rec('importContacts', { added: 1, updated: 0, invalid: [] }),
      removeContact: rec('removeContact'),
      contacts: async () => [{ id: 'p1', email: 'a@x.co', firstName: null, lastName: null, status: 'subscribed' }],
    },
  } as unknown as EmailPlatform
  const tools = createEmailManageTools({
    platform: () => fake,
    origin: async () => 'https://os.kindred.test',
    memberEmail: async (id) => (id === 'user-1' ? 'owner@kindred.test' : null),
    bought: async () => [],
    ...over,
  })
  const run = (name: string, input: unknown, ctx = human) => tools.find((t) => t.name === name)!.handler(ctx, input)
  return { calls, run, tools }
}

const draft = { name: 'Welcome', subject: 'Hi {{name}}', format: 'mjml', body: '<mjml></mjml>', sampleVariables: { name: 'Ann' } }

describe('email manage tools: the same service calls the Email pages make', () => {
  it('removing tools are destructive, starting a flow is external; every one has an activity sentence', () => {
    const { tools } = setup()
    for (const t of tools) {
      if (t.auditClass === 'read') continue
      expect(typeof t.activity).toBe('function')
      const expected = (EMAIL_PLATFORM_DESTRUCTIVE_TOOLS as readonly string[]).includes(t.name)
        ? 'destructive'
        : t.name === 'email.flow_set_status'
          ? 'external'
          : 'internal'
      expect(t.approvalRisk).toBe(expected)
    }
  })

  it('domains: delete, receiving with the server origin, tracking', async () => {
    const { calls, run } = setup()
    await run('email.domain_delete', { id: ID })
    await expect(run('email.domain_set_receiving', { id: ID, on: true })).resolves.toEqual({ receiving: true, receivingError: null })
    await run('email.domain_set_tracking', { id: ID, on: false })
    expect(calls).toEqual([
      ['deleteDomain', ID],
      ['setDomainReceiving', ID, true, 'https://os.kindred.test'],
      ['setDomainTracking', ID, false],
    ])
  })

  it('layouts and templates: create as the caller, save, delete', async () => {
    const { calls, run } = setup()
    await expect(run('email.layout_create', { name: 'Brand' })).resolves.toEqual({ id: 'l1' })
    await run('email.layout_update', { id: ID, name: 'Brand', format: 'html', body: '{{ content }}' })
    await run('email.layout_delete', { id: ID })
    await expect(run('email.template_create', { name: 'Welcome' })).resolves.toEqual({ id: 't1' })
    await run('email.template_update', { id: ID, ...draft })
    await run('email.template_delete', { id: ID })
    expect(calls).toEqual([
      ['createLayout', 'Brand', 'user-1'],
      ['updateLayout', ID, { name: 'Brand', format: 'html', body: '{{ content }}' }],
      ['deleteLayout', ID],
      ['createTemplate', { name: 'Welcome', layoutId: null }, 'user-1'],
      ['updateTemplate', ID, { ...draft, textBody: null, layoutId: null }],
      ['deleteTemplate', ID],
    ])
  })

  it('template test: saves the draft, then sends it to the calling person only', async () => {
    const { calls, run } = setup()
    await expect(run('email.template_send_test', { id: ID, ...draft })).resolves.toEqual({ sentTo: 'owner@kindred.test', status: 'queued' })
    expect(calls).toEqual([
      ['updateTemplate', ID, { ...draft, textBody: null, layoutId: null }],
      ['sendTest', ID, 'owner@kindred.test'],
    ])
    await expect(run('email.template_send_test', { id: ID, ...draft }, agent)).rejects.toThrow(/no email address/)
  })

  it('flows: create, save steps, start/pause, delete', async () => {
    const { calls, run } = setup()
    await run('email.flow_create', { name: 'Onboarding', listId: ID })
    await run('email.flow_update', { id: ID, name: 'Onboarding', steps: [{ kind: 'wait' }] })
    await run('email.flow_set_status', { id: ID, status: 'active' })
    await run('email.flow_delete', { id: ID })
    expect(calls).toEqual([
      ['createFlow', { name: 'Onboarding', triggerListId: ID }, 'user-1'],
      ['updateFlow', ID, { name: 'Onboarding', triggerListId: null, steps: [{ kind: 'wait' }] }],
      ['setFlowStatus', ID, 'active'],
      ['deleteFlow', ID],
    ])
  })

  it('lists: create, settings, import CSV text, people, remove one, delete', async () => {
    const { calls, run } = setup()
    await run('email.list_create', { name: 'News', doubleOptIn: true })
    await run('email.list_update', { id: ID, name: 'News', doubleOptIn: false, publicSignup: true })
    await expect(run('email.list_import', { listId: ID, csv: 'email\na@x.co' })).resolves.toMatchObject({ added: 1 })
    await expect(run('email.list_contacts', { listId: ID })).resolves.toEqual([
      { id: 'p1', email: 'a@x.co', firstName: null, lastName: null, status: 'subscribed' },
    ])
    await run('email.contact_remove', { id: ID })
    await run('email.list_delete', { id: ID })
    expect(calls).toEqual([
      ['createList', { name: 'News', doubleOptIn: true }, 'user-1'],
      ['updateList', ID, { name: 'News', description: null, doubleOptIn: false, publicSignup: true }],
      ['importContacts', ID, 'email\na@x.co'],
      ['removeContact', ID],
      ['deleteList', ID],
    ])
  })

  it('list import refuses CSV over the request body limit', async () => {
    const { run } = setup()
    await expect(run('email.list_import', { listId: ID, csv: 'x'.repeat(LIST_IMPORT_MAX_CHARS + 1) })).rejects.toThrow()
  })

  it('senders (own SES): default and remove by address; an unknown address fails loud', async () => {
    const { calls, run } = setup()
    await run('email.sender_set_default', { address: 'hi@kindred.test' })
    await run('email.sender_remove', { address: 'hi@kindred.test' })
    expect(calls).toEqual([
      ['setDefaultSender', 's1', 'user-1'],
      ['deleteSender', 's1'],
    ])
    await expect(run('email.sender_remove', { address: 'no@kindred.test' })).rejects.toThrow(/not one of the senders/)
  })

  it('senders (managed box): any address on a company domain becomes the default', async () => {
    const { calls, run } = setup({ mode: 'managed' })
    await expect(run('email.sender_set_default', { address: 'Hello@Kindred.test' })).resolves.toEqual({ address: 'hello@kindred.test', ready: true })
    expect(calls).toEqual([['owlery.setDefaultSender', 'hello@kindred.test', 'user-1']])
    await expect(run('email.sender_set_default', { address: 'a@other.test' })).rejects.toThrow(/not one of the company’s domains/)
  })

  it('setup at Amazon: delivery events and receiving use the server origin', async () => {
    const { calls, run } = setup()
    await expect(run('email.setup_events', {})).resolves.toEqual({ events: 'ready' })
    await expect(run('email.setup_receiving', {})).resolves.toEqual({ receiving: 'ready' })
    expect(calls).toEqual([
      ['setupEvents', 'https://os.kindred.test'],
      ['setupReceiving', 'https://os.kindred.test'],
    ])
  })
})
