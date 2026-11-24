import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EEM_ERROR as PROTOCOL_EEM_ERROR,
  MAX_FRAME_BYTES,
  MODULE_PROTOCOL,
  RECONNECT_GIVE_UP_MS,
  RECONNECT_INTERVAL_MS,
} from '../module-protocol'
import { CORE_API_TOOL_NAMES, createCoreApiClient } from './core-api'
import {
  EEM_ERROR,
  MAX_LINE_BYTES,
  PROTOCOL,
  RECONNECT_EVERY_MS,
  RECONNECT_GIVE_UP_MS as SDK_GIVE_UP,
  type ModuleContext,
  type ModuleDefinition,
} from './module-runtime.ts'
import { moduleTransport } from './module-transport.ts'
import { testKernel } from './test-kernel.ts'

/**
 * The module SDK (plan/phase-upgrades-u2.md §4.7): vendored into every module,
 * so it carries its own copies of the protocol constants — they must equal
 * the contract's — and it imports only node:* (it runs without node_modules).
 */

describe('module SDK', () => {
  it('speaks exactly the contract: eem/1, 4 MiB lines, -32000, reconnect every 1 s for 2 min', () => {
    expect(PROTOCOL).toBe(MODULE_PROTOCOL)
    expect(MAX_LINE_BYTES).toBe(MAX_FRAME_BYTES)
    expect(EEM_ERROR).toBe(PROTOCOL_EEM_ERROR)
    expect(RECONNECT_EVERY_MS).toBe(RECONNECT_INTERVAL_MS)
    expect(SDK_GIVE_UP).toBe(RECONNECT_GIVE_UP_MS)
  })

  it('imports only node:* and its own vendored files', () => {
    for (const file of ['module-runtime.ts', 'module-transport.ts', 'test-kernel.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      const specs = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!)
      for (const spec of specs) expect(spec.startsWith('node:') || /^\.\/module-[a-z]+\.ts$/.test(spec), `${file}: ${spec}`).toBe(true)
    }
  })

  it('the transport puts the typed core-api client on the module session', async () => {
    const calls: { name: string; input: unknown }[] = []
    const ctx: Pick<ModuleContext, 'call'> = {
      call: async (name, input) => {
        calls.push({ name, input })
        return { members: [] }
      },
    }
    const client = createCoreApiClient(moduleTransport(ctx))
    await expect(client.call('members.list', {})).resolves.toEqual({ members: [] })
    expect(calls).toEqual([{ name: 'members.list', input: {} }])
  })
})

describe('the test kernel enforces uses:', () => {
  const definition: ModuleDefinition = {
    tools: {
      who: async (_input, ctx) => (await ctx.call('members.list', {})) ?? null,
      sneaky: async (_input, ctx) => ctx.call('contacts.get', { id: 'x' }),
      save: async (input, ctx) => ctx.data.put('a.json', input),
      tell: async (_input, ctx) => ctx.emit('told', { n: 1 }),
    },
    events: {
      'contacts.created': async (event, ctx) => {
        await ctx.data.put(`seen/${event.id}.json`, true)
        await ctx.call('members.list', {})
      },
    },
  }
  const lockTools = [...CORE_API_TOOL_NAMES]

  it('runs tools as the person, refuses undeclared tools and events', async () => {
    const k = testKernel(definition, {
      uses: { tools: ['members.list'] },
      provides: { events: [] },
      lockTools,
      core: { 'members.list': () => ({ members: ['ann'] }) },
    })
    await expect(k.invoke('who', {})).resolves.toEqual({ members: ['ann'] })
    expect(k.calls[0]!.principal).toMatchObject({ id: 'test-person' })
    await expect(k.invoke('sneaky', {})).rejects.toMatchObject({ code: 'module_use_undeclared' })
    await expect(k.invoke('tell', {})).rejects.toMatchObject({ code: 'module_use_undeclared' })
    await k.invoke('save', { x: 1 })
    expect(k.data.get('a.json')).toEqual({ x: 1 })
  })

  it('a background call (an event) needs permissions.background', async () => {
    const strict = testKernel(definition, {
      uses: { tools: ['members.list'], events: ['contacts.created'] },
      lockTools,
      core: { 'members.list': () => ({ members: [] }) },
    })
    await expect(strict.deliver({ type: 'contacts.created', payload: {} })).rejects.toMatchObject({ code: 'module_no_person' })
    const background = testKernel(definition, {
      uses: { tools: ['members.list'], events: ['contacts.created'] },
      permissions: { background: true },
      lockTools,
      core: { 'members.list': () => ({ members: [] }) },
    })
    await background.deliver({ id: 'e1', type: 'contacts.created', payload: {} })
    expect(background.data.get('seen/e1.json')).toBe(true)
    expect(background.calls[0]!.principal).toBeNull()
    await expect(background.deliver({ type: 'contacts.deleted', payload: {} })).rejects.toThrow(/not in uses.events/)
  })

  it('every uses.tools name must be in the lock', () => {
    expect(() => testKernel(definition, { uses: { tools: ['nope.tool'] }, lockTools })).toThrow(/not in the core-api lock/)
  })
})
