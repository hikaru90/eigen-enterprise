import { connect } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { moduleSocketDir } from '../../../../contracts/module-workload'
import { emitKernelEvent } from '../events'
import type { ToolContext } from '../types'
import { EemCallError, EemConnection, type IncomingRequest } from './connection'
import { helloVersion } from './testing/hello'
import { MEMBER, OWNER, recordingWorkload, testHostKernel, until, type TestHostKernel } from './testing/kernel'

/**
 * eem/1 from the module's side, scripted in the spec (plan/phase-upgrades-u2.md
 * §4.2–§4.4): authentication, the `uses:` and person rules of tools.call,
 * events.emit, data.* and at-least-once event delivery across a reconnect.
 */

const C1 = 'a'.repeat(40)
let k: TestHostKernel
let workload: ReturnType<typeof recordingWorkload>
const membersCalls: ToolContext[] = []

beforeEach(async () => {
  membersCalls.length = 0
  workload = recordingWorkload()
  k = await testHostKernel({
    workload: () => workload,
    limits: { deliveryRetryBaseMs: 30, deliveryAckTimeoutMs: 300 },
  })
  // A core tool the module may use (hello's uses.tools: members.list).
  k.modules.register({ id: 'members', name: 'Members', version: '1.0.0', tools: ['members.list'], permissions: { roles: ['admin', 'member', 'agent'] } })
  await k.activations.set('members', true)
  k.registry.register({
    name: 'members.list',
    module: 'members',
    summary: 'List members',
    inputSchema: z.object({}),
    permission: { roles: ['admin', 'member', 'agent'] },
    auditClass: 'read',
    handler: async (ctx) => {
      membersCalls.push(ctx)
      return { members: [{ id: 'ann' }] }
    },
  })
  k.modules.register({ id: 'contacts', name: 'Contacts', version: '1.0.0', tools: ['contacts.get'], permissions: { roles: ['admin'] } })
})
afterEach(async () => {
  await k.cleanup()
})

type Client = {
  conn: EemConnection
  requests: IncomingRequest[]
  closed: Promise<void>
}

/** A raw module connection; `answer` decides each kernel → module request. */
function client(answer: (req: IncomingRequest) => Promise<unknown> = async () => ({})): Promise<Client> {
  const socket = connect(join(moduleSocketDir(k.stateDir, 'hello'), 'kernel.sock'))
  const requests: IncomingRequest[] = []
  let onClosed!: () => void
  const closed = new Promise<void>((r) => (onClosed = r))
  const conn = new EemConnection(socket, {
    onRequest: async (req) => {
      requests.push(req)
      return answer(req)
    },
    onViolation: () => undefined,
    onClose: () => onClosed(),
  })
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({ conn, requests, closed }))
    socket.once('error', reject)
  })
}

async function deployRaw(manifest?: Parameters<typeof helloVersion>[1]['manifest']) {
  await k.scaffold('hello')
  await k.deploy(await helloVersion(C1, manifest ? { manifest } : {}))
  const body = workload.calls.find((c) => c.verb === 'deploy')!.body as { token: string }
  return body.token
}

async function connected(token: string, answer?: (req: IncomingRequest) => Promise<unknown>): Promise<Client> {
  const c = await client(answer)
  await c.conn.call('hello', { protocol: 'eem/1', moduleId: 'hello', commit: C1, token })
  await c.conn.call('ready', {})
  return c
}

describe('eem/1 authentication', () => {
  it('answers hello with the core-api version, the heartbeat and the grants; ready makes it running', async () => {
    const token = await deployRaw()
    const c = await client()
    await expect(c.conn.call('hello', { protocol: 'eem/1', moduleId: 'hello', commit: C1, token })).resolves.toEqual({
      coreApi: '1.0.0',
      heartbeatMs: 10_000,
      grants: { background: false, secrets: [] },
    })
    expect((await k.store.get('hello'))?.state).toBe('connecting')
    await c.conn.call('ready', {})
    expect((await k.store.get('hello'))?.state).toBe('running')
    expect(k.principals.hashes.get('hello')).toMatch(/^[0-9a-f]{64}$/)
    expect(k.principals.hashes.get('hello')).not.toBe(token)
  })

  it('refuses anything but a matching hello first, and closes', async () => {
    const token = await deployRaw()
    const wrongFirst = await client()
    await expect(wrongFirst.conn.call('heartbeat', {})).rejects.toMatchObject({ code: 'module_protocol' })
    await wrongFirst.closed
    const badToken = await client()
    await expect(
      badToken.conn.call('hello', { protocol: 'eem/1', moduleId: 'hello', commit: C1, token: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'module_protocol' })
    await badToken.closed
    const badCommit = await client()
    await expect(
      badCommit.conn.call('hello', { protocol: 'eem/1', moduleId: 'hello', commit: 'b'.repeat(40), token }),
    ).rejects.toBeInstanceOf(EemCallError)
    await badCommit.closed
  })

  it('a newer hello replaces the older connection', async () => {
    const token = await deployRaw()
    const first = await connected(token)
    const second = await connected(token)
    await first.closed
    await expect(second.conn.call('heartbeat', {})).resolves.toEqual({})
  })
})

describe('after a restore', () => {
  it('a running module ee no longer has is re-POSTed at the os start; one that cannot be is switched off loudly', async () => {
    await deployRaw()
    await connected(workload.calls.find((c) => c.verb === 'deploy')!.body.token as string)
    expect((await k.store.get('hello'))?.state).toBe('running')
    await k.host.stop()
    workload.views.clear() // ee restored without the module's bundle
    await k.host.start()
    expect(workload.calls.filter((c) => c.verb === 'deploy')).toHaveLength(2)
    expect((await k.store.get('hello'))?.state).toBe('connecting')

    await k.host.stop()
    workload.views.clear()
    k.bundles.clear() // and the bytes are nowhere
    await k.host.start()
    expect((await k.store.get('hello'))?.reason).toBe(
      'Hello is switched off because it could not be brought back on this server. Its data is kept.',
    )
  })
})

describe('tools.call: uses and the person rule (§4.3)', () => {
  it('a tool not in uses.tools is module_use_undeclared', async () => {
    const c = await connected(await deployRaw())
    await expect(c.conn.call('tools.call', { name: 'contacts.get', input: {} })).rejects.toMatchObject({
      code: 'module_use_undeclared',
    })
  })

  it('a background call without permissions.background is module_no_person', async () => {
    const c = await connected(await deployRaw())
    await expect(c.conn.call('tools.call', { name: 'members.list', input: {} })).rejects.toMatchObject({
      code: 'module_no_person',
    })
    expect(membersCalls).toEqual([])
  })

  it('with permissions.background it runs as its owner, via module', async () => {
    const c = await connected(
      await deployRaw((m) => ({ ...m, permissions: { ...m.permissions, background: true } })),
    )
    await expect(c.conn.call('tools.call', { name: 'members.list', input: {} })).resolves.toEqual({
      members: [{ id: 'ann' }],
    })
    expect(membersCalls[0]!.principal).toEqual({
      id: OWNER.id,
      kind: 'human',
      roles: OWNER.roles,
      via: 'module',
      moduleId: 'hello',
    })
  })

  it('with the callId of a live tool.invoke it runs as the invoking person, never more', async () => {
    let inner: unknown = null
    const token = await deployRaw()
    const c = await connected(token, async (req) => {
      if (req.method !== 'tool.invoke') return {}
      const p = req.params as { callId: string; principal: unknown }
      expect(p.principal).toEqual({ id: MEMBER.id, kind: 'human', roles: MEMBER.roles })
      inner = await c.conn.call('tools.call', { name: 'members.list', input: {}, callId: p.callId })
      return { greeting: 'Hello, Ann!' }
    })
    await expect(
      k.registry.execute('x_hello.greet', { name: 'Ann' }, { principal: MEMBER, requestId: 'r' }),
    ).resolves.toEqual({ greeting: 'Hello, Ann!' })
    expect(inner).toEqual({ members: [{ id: 'ann' }] })
    expect(membersCalls[0]!.principal).toMatchObject({ id: MEMBER.id, roles: MEMBER.roles, via: 'module', moduleId: 'hello' })
    // After the call ended its callId is spent.
    await expect(
      c.conn.call('tools.call', { name: 'members.list', input: {}, callId: 'stale' }),
    ).rejects.toMatchObject({ code: 'module_no_person' })
  })

  it('an output its manifest does not allow is invalid_output, and five of them switch it off', async () => {
    const token = await deployRaw()
    await connected(token, async () => ({ wrong: true }))
    for (let i = 0; i < 4; i++) {
      await expect(
        k.registry.execute('x_hello.greet', { name: 'Ann' }, { principal: MEMBER, requestId: 'r' }),
      ).rejects.toMatchObject({ code: 'invalid_output' })
    }
    expect((await k.store.get('hello'))?.state).toBe('running')
    await expect(
      k.registry.execute('x_hello.greet', { name: 'Ann' }, { principal: MEMBER, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'invalid_output' })
    expect((await k.store.get('hello'))?.reason).toBe(
      'Hello is switched off because it kept breaking its contract. Its data is kept.',
    )
  })

  it('a timeout is module_timeout and not a failure', async () => {
    const token = await deployRaw((m) => ({
      ...m,
      provides: { ...m.provides, tools: [{ ...m.provides.tools[0], timeoutMs: 1000 }] },
    }))
    await connected(token, () => new Promise(() => undefined))
    await expect(
      k.registry.execute('x_hello.greet', { name: 'Ann' }, { principal: MEMBER, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'module_timeout' })
    expect((await k.store.get('hello'))?.state).toBe('running')
  })
})

describe('events and data', () => {
  it('events.emit stores x_<id_>.<name>; an undeclared name is refused', async () => {
    const c = await connected(
      await deployRaw((m) => ({ ...m, provides: { ...m.provides, events: [{ name: 'greeted' }] } })),
    )
    const { id } = (await c.conn.call('events.emit', { name: 'greeted', payload: { who: 'Ann' } })) as { id: string }
    expect(k.eventSink.events.find((e) => e.id === id)).toMatchObject({
      type: 'x_hello.greeted',
      principalId: 'module:hello',
      payload: { who: 'Ann' },
    })
    await expect(c.conn.call('events.emit', { name: 'other', payload: {} })).rejects.toMatchObject({
      code: 'module_use_undeclared',
    })
  })

  it('data.* reads and writes extensions/<id>/ as the module, with etags and conflicts', async () => {
    const c = await connected(await deployRaw())
    const { etag } = (await c.conn.call('data.put', { path: 'a/b.json', content: { n: 1 } })) as { etag: string }
    expect(k.data.files.get('extensions/hello/a/b.json')?.toString()).toBe('{"n":1}\n')
    expect(k.data.commits.at(-1)).toMatchObject({ authorId: 'module:hello' })
    await expect(c.conn.call('data.get', { path: 'a/b.json' })).resolves.toEqual({ content: { n: 1 }, etag })
    await expect(c.conn.call('data.put', { path: 'a/b.json', content: 2, ifMatch: 'nope' })).rejects.toMatchObject({
      code: 'data_conflict',
    })
    await expect(c.conn.call('data.list', { prefix: 'a/' })).resolves.toEqual({
      items: [{ path: 'a/b.json', etag, size: 8 }],
      cursor: null,
    })
    await c.conn.call('data.delete', { path: 'a/b.json', ifMatch: etag })
    await expect(c.conn.call('data.get', { path: 'a/b.json' })).rejects.toMatchObject({ code: 'data_not_found' })
    await expect(c.conn.call('data.get', { path: '../escape' })).rejects.toMatchObject({ code: 'module_protocol' })
    await expect(c.conn.call('data.put', { path: 'big', content: 'x'.repeat(1024 * 1024) })).rejects.toMatchObject({
      code: 'data_quota',
    })
  })

  it('delivers uses.events at-least-once and in order, across a reconnect', async () => {
    const token = await deployRaw((m) => ({ ...m, uses: { ...m.uses, events: ['contacts.created'] } }))
    const emit = (n: number) =>
      emitKernelEvent(k.eventSink, { type: 'contacts.created', principalId: OWNER.id, payload: { n } })
    // Not delivered: a type the module does not use.
    await emitKernelEvent(k.eventSink, { type: 'contacts.deleted', payload: { n: 0 } })
    const e1 = await emit(1)
    const e2 = await emit(2)

    // The first connection takes event 1 and dies without acking.
    const first = await connected(token, async (req) => {
      if (req.method === 'event.deliver') {
        setImmediate(() => first.conn.close())
        return new Promise(() => undefined)
      }
      return {}
    })
    void k.host.pump('hello')
    await first.closed
    expect(first.requests.map((r) => (r.params as { event: { id: string } }).event.id)).toEqual([e1.id])

    // The next connection gets event 1 again, then 2.
    const seen: string[] = []
    await connected(token, async (req) => {
      if (req.method === 'event.deliver') seen.push((req.params as { event: { id: string } }).event.id)
      return {}
    })
    await until(async () => {
      await k.host.pump('hello')
      return seen.length >= 2
    }, 5_000, 'redelivery')
    expect(seen).toEqual([e1.id, e2.id])
    expect((await k.cursors.get('hello'))?.lastId).toBe(e2.id)
    await k.host.pump('hello')
    expect(seen).toHaveLength(2)
  })
})
