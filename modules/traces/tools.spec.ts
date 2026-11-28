import type { TracesDeps } from './service'
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { TRACES_TOOL_NAMES } from './manifest'
import { memoryTraceStore } from './memory-store'
import { createTracesTools } from './tools'
import { TRACE_PATHS, type TraceHub } from './worker'

/** Kernel roles never carry `owner` (an owner is an admin to the registry): the tools read the person's company role. */
const ctx = (roles: string[], kind: 'human' | 'agent' = 'human') =>
  ({ principal: { id: roles.includes('owner') ? 'owner-1' : 'admin-1', kind, roles: ['admin', 'member'] } }) as unknown as ToolContext
const roleOf = async (id: string) => (id === 'owner-1' ? 'owner' : 'admin')
const BATCH = '00000000-0000-4000-8000-000000000001'

function setup(status = 200) {
  const store = memoryTraceStore()
  const send = vi.fn(async () => ({ status, text: '' }))
  const hub: TraceHub = { config: () => ({ ok: true }), ready: async () => ({ ok: true }), send, unauthorized: async () => {} }
  const d: TracesDeps = { store, hub, now: () => new Date('2026-11-21T00:00:00Z') }
  const tools = new Map(createTracesTools({ deps: async () => d, roleOf }).map((t) => [t.name, t]))
  return { store, send, tools }
}

async function seed(store: ReturnType<typeof memoryTraceStore>) {
  await store.createBatch(
    { id: BATCH, state: 'pending', spanCount: 1, body: { v: 1, batch_id: BATCH, spans: [] }, withheld: [{ field: 'tool', value: 'x.y' }], attempts: 0, nextAttemptAt: new Date(0), lastError: null, createdAt: new Date('2026-11-20T00:00:00Z'), sentAt: null, withdrawnAt: null },
    {},
  )
  await store.markSent(BATCH, new Date('2026-11-20T00:01:00Z'))
}

describe('traces.* tools (plan/traces-phone-home.md §4)', () => {
  it('declares exactly the manifest tools', () => {
    expect([...setup().tools.keys()]).toEqual([...TRACES_TOOL_NAMES])
  })

  it('sent_list and sent_get show exactly what was sent, withheld values included', async () => {
    const { store, tools } = setup()
    await seed(store)
    const list = (await tools.get('traces.sent_list')!.handler(ctx(['admin']), {})) as { batches: unknown[] }
    expect(list.batches).toEqual([expect.objectContaining({ id: BATCH, state: 'sent', spanCount: 1, withheldCount: 1 })])
    const one = (await tools.get('traces.sent_get')!.handler(ctx(['admin']), { id: BATCH })) as { body: unknown }
    expect(one).toMatchObject({ body: { v: 1, batch_id: BATCH }, withheld: [{ field: 'tool', value: 'x.y' }] })
  })

  it('settings_get is on by default and lists the Tier A fields', async () => {
    const { tools } = setup()
    const s = (await tools.get('traces.settings_get')!.handler(ctx(['admin']), {})) as { enabled: boolean; fields: string[] }
    expect(s.enabled).toBe(true)
    expect(s.fields).toContain('tool')
    expect(s.fields).not.toContain('context')
  })

  it('settings_set is the owner’s: off + withdraw deletes everything from the hub', async () => {
    const { store, send, tools } = setup()
    await seed(store)
    const set = tools.get('traces.settings_set')!
    expect(set.permission.roles).toEqual(['owner', 'admin'])
    await expect(set.handler(ctx(['admin']), { enabled: false })).rejects.toThrow(/Only the owner/)
    const out = (await set.handler(ctx(['owner']), { enabled: false, withdraw: true })) as { enabled: boolean; withdrawn: string[] }
    expect(out).toMatchObject({ enabled: false, withdrawn: [BATCH] })
    expect(send).toHaveBeenCalledWith({ method: 'DELETE', path: TRACE_PATHS.traces, body: '' })
  })

  it('withdraw one batch sends its DELETE; a hub error is reported and nothing is marked', async () => {
    const ok = setup()
    await seed(ok.store)
    await ok.tools.get('traces.withdraw')!.handler(ctx(['owner']), { batch_id: BATCH })
    expect(ok.send).toHaveBeenCalledWith({ method: 'DELETE', path: TRACE_PATHS.batch(BATCH), body: '' })
    expect((await ok.store.getBatch(BATCH))!.state).toBe('withdrawn')
    const bad = setup(500)
    await seed(bad.store)
    await expect(bad.tools.get('traces.withdraw')!.handler(ctx(['owner']), { batch_id: BATCH })).rejects.toThrow(/HTTP 500/)
    expect((await bad.store.getBatch(BATCH))!.state).toBe('sent')
  })

  it('the agent on its own cannot switch or withdraw', async () => {
    const { tools } = setup()
    await expect(tools.get('traces.settings_set')!.handler(ctx(['owner'], 'agent'), { enabled: false })).rejects.toThrow(/not the agent/)
  })

  it('the one-time Needs you notice: the owner sees what is shared and where the switch is, until they mark it seen', async () => {
    const { tools } = setup()
    const get = tools.get('traces.notice_get')!
    const seen = tools.get('traces.notice_seen')!
    const n = (await get.handler(ctx(['owner']), {})) as { notice: { sentence: string; href: string } | null }
    expect(n.notice).toMatchObject({ href: '/settings/company' })
    expect(n.notice!.sentence).toMatch(/usage statistics/i)
    expect(((await get.handler(ctx(['admin']), {})) as { notice: unknown }).notice).toBeNull()
    expect(seen.permission.roles).toEqual(['owner', 'admin'])
    await expect(seen.handler(ctx(['admin']), {})).rejects.toThrow(/Only the owner/)
    expect(await seen.handler(ctx(['owner']), {})).toEqual({ seen: true })
    expect(((await get.handler(ctx(['owner']), {})) as { notice: unknown }).notice).toBeNull()
  })
})
