import { describe, expect, it } from 'vitest'
import { InboxHub, inboxStreamResponse, parseNotifyPayload } from './hub'
import { assignPersonalMailbox, createSharedMailbox } from './service'
import { fixture } from './test-fixtures'

/** Live mail: a NOTIFY carries a mailbox id; only people who read that mailbox right now hear about it. */

async function setup() {
  const f = fixture()
  const ana = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana', domainId: 'd-1' })
  const sales = await createSharedMailbox(f.deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1' })
  return { ...f, ana, sales, hub: new InboxHub(f.deps) }
}

describe('InboxHub', () => {
  it('sends the mailbox id only to people who read that mailbox — never the owner for a personal one', async () => {
    const { hub, ana, sales } = await setup()
    const heard: Record<string, string[]> = { ana: [], sam: [], olga: [], ben: [] }
    for (const who of Object.keys(heard)) hub.subscribe(who, (id) => heard[who]!.push(id))
    await hub.dispatch(ana.id)
    await hub.dispatch(sales.id)
    expect(heard).toEqual({ ana: [ana.id, sales.id], sam: [sales.id], olga: [], ben: [] })
  })

  it('checks access per event, so leaving a group stops the feed at once', async () => {
    const { deps, hub, sales } = await setup()
    const heard: string[] = []
    hub.subscribe('sam', (id) => heard.push(id))
    await hub.dispatch(sales.id)
    deps.groups = async () => [{ id: 'g-sales', name: 'Sales', memberIds: ['ana'] }]
    await hub.dispatch(sales.id)
    expect(heard).toEqual([sales.id])
  })

  it('unsubscribes', async () => {
    const { hub, ana } = await setup()
    const heard: string[] = []
    const off = hub.subscribe('ana', (id) => heard.push(id))
    off()
    await hub.dispatch(ana.id)
    expect(heard).toEqual([])
    expect(hub.size).toBe(0)
  })

  it('one failing access check does not stop the others', async () => {
    const { deps, hub, ana } = await setup()
    const realRole = deps.roleOf
    deps.roleOf = async (id) => {
      if (id === 'broken') throw new Error('db down')
      return realRole(id)
    }
    const heard: string[] = []
    hub.subscribe('broken', () => {})
    hub.subscribe('ana', (id) => heard.push(id))
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      await hub.dispatch(ana.id)
    } finally {
      console.error = original
    }
    expect(heard).toEqual([ana.id])
    expect(errors).toHaveLength(1)
  })
})

describe('parseNotifyPayload', () => {
  it('accepts a mailbox uuid only', () => {
    expect(parseNotifyPayload('5f0c7f2e-8c1a-4d55-9a57-0d1c2b3a4e5f')).toBe('5f0c7f2e-8c1a-4d55-9a57-0d1c2b3a4e5f')
    expect(parseNotifyPayload('nope')).toBeNull()
    expect(parseNotifyPayload('')).toBeNull()
  })
})

describe('inboxStreamResponse', () => {
  it('streams `mailbox` events with the id only, and stops on abort', async () => {
    const { hub, ana } = await setup()
    const abort = new AbortController()
    const res = inboxStreamResponse(hub, 'ana', abort.signal)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const read = async () => decoder.decode((await reader.read()).value)
    expect(await read()).toBe(': connected\n\n')
    await hub.dispatch(ana.id)
    expect(await read()).toBe(`event: mailbox\ndata: ${JSON.stringify({ mailboxId: ana.id })}\n\n`)
    abort.abort()
    expect(hub.size).toBe(0)
  })
})
