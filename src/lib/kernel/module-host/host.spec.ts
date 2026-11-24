import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelError } from '../errors'
import { ModuleRegistry, InMemoryActivationStore } from '../modules'
import type { ToolContext } from '../types'
import { moduleNotices } from './notices'
import { FakeModuleWorkload } from './testing/fake-workload'
import { helloVersion } from './testing/hello'
import {
  AGENT,
  MEMBER,
  OWNER,
  recordingWorkload,
  testHostKernel,
  until,
  type TestHostKernel,
} from './testing/kernel'

/**
 * Stream A "Done when" (plan/phase-upgrades-u2.md §9): the hello fixture
 * module, spawned as a real child process by the fake ee, speaks eem/1 to the
 * kernel's socket; its tool runs through the registry; a failing module is
 * switched off loudly and comes back with a new commit.
 */

const C1 = '1'.repeat(40)
const C2 = '2'.repeat(40)
const ctx = (principal: ToolContext['principal']): ToolContext => ({ principal, requestId: 'r' })

let k: TestHostKernel
beforeEach(async () => {
  k = await testHostKernel({ limits: { heartbeatMs: 100, heartbeatMissMs: 600, readyTimeoutMs: 5_000 } })
})
afterEach(async () => {
  await k.cleanup()
})

async function deployHello(commit = C1) {
  if (!(await k.store.get('hello'))) await k.scaffold('hello')
  await k.deploy(await helloVersion(commit))
  await until(async () => (await k.store.get('hello'))?.state === 'running', 10_000, 'hello to run')
}

describe('the module host with the hello fixture', () => {
  it('hello connects and x_hello.greet works through registry.execute', async () => {
    await deployHello()
    expect(k.registry.get('x_hello.greet')?.module).toBe('x-hello')
    await expect(k.registry.execute('x_hello.greet', { name: 'Ann' }, ctx(MEMBER))).resolves.toEqual({
      greeting: 'Hello, Ann!',
    })
    // Input is the manifest's schema.
    await expect(k.registry.execute('x_hello.greet', { name: '' }, ctx(MEMBER))).rejects.toMatchObject({
      code: 'invalid_input',
    })
    const types = k.eventSink.events.map((e) => e.type)
    expect(types).toContain('module.deployed')
    expect(await k.activations.get('x-hello')).toBe(true)
    expect(k.pins).toEqual([
      {
        id: 'hello',
        entry: expect.objectContaining({ id: 'hello', version: '0.1.0', commit: C1 }),
        by: OWNER.id,
      },
    ])
    expect(k.host.session('hello')).toMatchObject({ connected: true, ready: true, commit: C1 })
  })

  it('without a live session a proxy fails with module_not_running and the sentence', async () => {
    // ee refuses: nothing runs, and the record goes back as it was.
    const failing = await testHostKernel({
      workload: () =>
        recordingWorkload({
          deploy: async () => {
            throw new Error('urn:ee:receipt_invalid: refused')
          },
        }),
    })
    try {
      await failing.scaffold('hello')
      await expect(failing.deploy(await helloVersion(C1))).rejects.toThrow(/receipt_invalid/)
      expect((await failing.store.get('hello'))?.state).toBe('unpublished')
      expect(failing.registry.get('x_hello.greet')).toBeUndefined()
    } finally {
      await failing.cleanup()
    }
  })

  it('a core manifest can never own x-/x_ names', () => {
    const modules = new ModuleRegistry(new InMemoryActivationStore())
    expect(() =>
      modules.register({ id: 'evil', name: 'Evil', version: '1.0.0', toolNamespaces: ['evil', 'x_hello'], tools: [], permissions: { roles: ['admin'] } }),
    ).toThrow(/company-module space/)
    expect(() =>
      modules.register({ id: 'x-hello', name: 'Hello', version: '1.0.0', tools: [], permissions: { roles: ['admin'] } }),
    ).toThrow(/company-module space/)
    // A company module must own exactly its two names.
    expect(() =>
      modules.registerCompanyModule(
        { id: 'x-hello', name: 'Hello', version: '1.0.0', toolNamespaces: ['x-hello', 'x_hello', 'contacts'], tools: [], permissions: { roles: ['admin'] } },
        'hello',
      ),
    ).toThrow(/exactly the namespaces/)
  })

  it('a heartbeat miss switches it off loudly: failed, ee stopped, module.failed, Needs you, data intact; a new commit brings it back', async () => {
    await deployHello()
    k.data.files.set('extensions/hello/notes.json', Buffer.from('{"kept":true}\n'))
    const workload = k.workload as FakeModuleWorkload
    workload.child('hello').kill('SIGSTOP') // alive, socket open, no heartbeats
    await new Promise((r) => setTimeout(r, 800))
    await k.host.tick()

    const failed = await k.store.get('hello')
    expect(failed?.state).toBe('failed')
    expect(failed?.reason).toBe('Hello is switched off because it stopped answering. Its data is kept.')
    expect(workload.calls.filter((c) => c.verb === 'stop')).toEqual([
      { verb: 'stop', id: 'hello', body: { author: 'kernel', reason: 'failed', sentence: failed!.reason } },
    ])
    expect(k.eventSink.events.filter((e) => e.type === 'module.failed')).toHaveLength(1)
    expect(k.data.files.get('extensions/hello/notes.json')?.toString()).toBe('{"kept":true}\n')
    // Needs you: the owner and the admins see the sentence; a member who doesn't own it does not.
    const records = await k.store.list()
    expect(moduleNotices(records, { by: OWNER.id, at: 'x' }, { userId: OWNER.id, isOwner: true, isAdmin: true })).toEqual([
      expect.objectContaining({ kind: 'module_failed', moduleId: 'hello', sentence: failed!.reason }),
    ])
    expect(moduleNotices(records, { by: OWNER.id, at: 'x' }, { userId: MEMBER.id, isOwner: false, isAdmin: false })).toEqual([])
    // Its tools say why.
    await expect(k.registry.execute('x_hello.greet', { name: 'Ann' }, ctx(MEMBER))).rejects.toMatchObject({
      code: 'module_not_running',
      details: { module: 'hello', state: 'failed', sentence: failed!.reason },
    })

    // A new commit that starts and sends ready brings it back.
    await k.deploy(await helloVersion(C2, { extra: [{ path: 'CHANGELOG.md', content: Buffer.from('fixed\n') }] }))
    await until(async () => (await k.store.get('hello'))?.state === 'running', 10_000, 'hello to recover')
    expect(k.eventSink.events.map((e) => e.type)).toContain('module.recovered')
    // The hub learns which version runs here (§6.2 PUT …/run): running, failed, running again.
    expect(k.runReports.map((r) => r.state)).toEqual(['running', 'failed', 'running'])
    expect(new Set(k.runReports.map((r) => r.moduleId))).toEqual(new Set(['hello']))
    await expect(k.registry.execute('x_hello.greet', { name: 'Bo' }, ctx(MEMBER))).resolves.toEqual({
      greeting: 'Hello, Bo!',
    })
  })

  it('no ready within the window makes it failed', async () => {
    const slow = await testHostKernel({ limits: { readyTimeoutMs: 50 } })
    try {
      await slow.scaffold('hello')
      // A module that never speaks: start a process that just sleeps.
      await slow.deploy(
        await helloVersion(C1, { manifest: (m) => ({ ...m, start: ['node', '-e', 'setTimeout(() => {}, 60000)'] }) }),
      )
      await new Promise((r) => setTimeout(r, 100))
      await slow.host.tick()
      expect((await slow.store.get('hello'))?.reason).toBe(
        'Hello is switched off because it did not start within a minute. Its data is kept.',
      )
    } finally {
      await slow.cleanup()
    }
  })

  it('after a person switched it off, the agent cannot switch it back on; a person can', async () => {
    await deployHello()
    await k.registry.execute('kernel.module_deactivate', { module_id: 'x-hello' }, ctx(OWNER))
    const off = await k.store.get('hello')
    expect(off?.state).toBe('off')
    expect(k.eventSink.events.map((e) => e.type)).toContain('module.switched_off')
    expect((k.workload as FakeModuleWorkload).calls.at(-1)).toMatchObject({ verb: 'stop', body: { reason: 'person' } })

    await expect(k.registry.execute('kernel.module_activate', { module_id: 'x-hello' }, ctx(AGENT))).rejects.toMatchObject({
      code: 'module_switched_off',
    })
    // Deploying a new commit while off records it and starts nothing.
    await k.deploy(await helloVersion(C2, { extra: [{ path: 'NOTE.md', content: Buffer.from('n\n') }] }))
    expect(await k.store.get('hello')).toMatchObject({ state: 'off', commit: C2 })

    await k.registry.execute('kernel.module_activate', { module_id: 'x-hello' }, ctx(OWNER))
    await until(async () => (await k.store.get('hello'))?.state === 'running', 10_000, 'hello to run again')
    expect((await k.store.get('hello'))?.commit).toBe(C2)
    expect(k.eventSink.events.map((e) => e.type)).toContain('module.switched_on')
  })

  it('an admin activate on a failed module retries the same commit', async () => {
    await deployHello()
    await k.host.fail('hello', 'it stopped answering')
    expect((await k.store.get('hello'))?.state).toBe('failed')
    await k.registry.execute('kernel.module_activate', { module_id: 'x-hello' }, ctx(OWNER))
    await until(async () => (await k.store.get('hello'))?.state === 'running', 10_000, 'hello to run again')
    expect((await k.store.get('hello'))?.commit).toBe(C1)
    expect(k.eventSink.events.map((e) => e.type)).toContain('module.recovered')
  })

  it('a removed module leaves its tools, its manifest and ee; its data stays', async () => {
    await deployHello()
    k.data.files.set('extensions/hello/a.json', Buffer.from('1\n'))
    await k.host.remove('hello', OWNER.id)
    expect(k.registry.get('x_hello.greet')).toBeUndefined()
    expect(k.modules.get('x-hello')).toBeUndefined()
    expect(await k.store.get('hello')).toBeNull()
    expect(k.data.files.has('extensions/hello/a.json')).toBe(true)
    expect(k.pins.at(-1)).toEqual({ id: 'hello', entry: null, by: OWNER.id })
    expect(k.eventSink.events.map((e) => e.type)).toContain('module.removed')
    expect(() => k.registry.unregister('kernel.module_list')).toThrow(/core module/)
  })

  it('kernel errors from the registry carry their codes', () => {
    expect(new KernelError('module_use_undeclared', 'x').toProblemJson().status).toBe(403)
  })
})
