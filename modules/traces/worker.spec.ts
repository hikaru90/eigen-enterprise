import type { TraceSourceRow } from './payload'
import type { TraceCursor, TraceSource } from './store'
import { describe, expect, it, vi } from 'vitest'
import { memoryTraceStore } from './memory-store'
import { backoffMs, BUILD_EVERY_MS, REVOKED, runTraceTick, SETTLE_MS, TRACE_PATHS, type TraceHub, type TraceWorkerDeps } from './worker'

const T0 = new Date('2026-11-20T10:00:00Z')

/** A fake source table: rows by source, each with its (at, id) cursor; reads honour after/until/limit. */
function table(rows: Array<TraceSourceRow & { cursor: TraceCursor }>) {
  return vi.fn(async (source: TraceSource, after: TraceCursor, until: Date, limit: number) =>
    rows
      .filter((r) => r.source === source)
      .filter((r) => r.cursor.at > after.at || (r.cursor.at.getTime() === after.at.getTime() && r.cursor.id > after.id))
      .filter((r) => r.cursor.at < until)
      .slice(0, limit),
  )
}

const tool = (id: string, at: Date, name = 'memory.list_tasks'): TraceSourceRow & { cursor: TraceCursor } => ({
  source: 'tool_call', localId: id, traceKey: null, at, tool: name, auditClass: 'read', ok: true, via: null, durationMs: 3, cursor: { at, id },
})

function hub(statuses: number[] = []): TraceHub & { sent: Array<{ method: string; path: string; body: string }> } {
  const sent: Array<{ method: string; path: string; body: string }> = []
  return {
    sent,
    config: () => ({ ok: true }),
    ready: async () => ({ ok: true }),
    send: async (req) => {
      sent.push(req)
      const s = statuses.shift() ?? 200
      if (s === 0) throw new Error('ECONNREFUSED')
      return { status: s, text: '' }
    },
    unauthorized: vi.fn(async () => {}),
  }
}

function deps(over: Partial<TraceWorkerDeps> & { clock?: { t: Date } } = {}) {
  const clock = over.clock ?? { t: T0 }
  let n = 0
  const d: TraceWorkerDeps = {
    store: memoryTraceStore(),
    read: table([]),
    hub: hub(),
    decide: vi.fn(async () => 'usage_meta' as const),
    appVersion: '0.5.47',
    eeVersion: null,
    now: () => clock.t,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    ...over,
  }
  return { d, clock }
}

const later = (ms: number) => new Date(T0.getTime() + ms)

describe('runTraceTick (plan/traces-phone-home.md T2)', () => {
  it('first tick only places the cursors (no backfill); rows after that are sent once, never again', async () => {
    const rows = [tool('a', later(-10_000)), tool('b', later(1000)), tool('c', later(2000))]
    const h = hub()
    const { d, clock } = deps({ read: table(rows), hub: h })
    await runTraceTick(d)
    expect(h.sent).toHaveLength(0)
    clock.t = later(2000 + SETTLE_MS + 1)
    const out = await runTraceTick(d)
    expect(out).toMatchObject({ built: 1, spans: 2, sent: 1 })
    expect(h.sent[0]).toMatchObject({ method: 'POST', path: TRACE_PATHS.traces })
    expect(JSON.parse(h.sent[0]!.body).spans).toHaveLength(2)
    clock.t = later(10 * SETTLE_MS)
    await runTraceTick(d)
    expect(h.sent).toHaveLength(1)
  })

  it('switched off: nothing is read, built or sent', async () => {
    const read = table([tool('b', later(1000))])
    const h = hub()
    const { d } = deps({ read, hub: h })
    await d.store.setEnabled(false, 'owner', T0)
    expect(await runTraceTick(d)).toMatchObject({ skipped: 'off' })
    expect(read).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(0)
  })

  it('a 5xx or no answer backs off (1 min doubling), then sends the same batch', async () => {
    const h = hub([503, 0, 200])
    const { d, clock } = deps({ read: table([tool('b', later(1000))]), hub: h })
    await runTraceTick(d)
    clock.t = later(1000 + SETTLE_MS + 1)
    expect(await runTraceTick(d)).toMatchObject({ retried: 1 })
    const [b] = await d.store.listBatches(5)
    expect(b!.nextAttemptAt.getTime() - clock.t.getTime()).toBe(backoffMs(1))
    clock.t = new Date(b!.nextAttemptAt.getTime())
    expect(await runTraceTick(d)).toMatchObject({ retried: 1 })
    clock.t = new Date((await d.store.getBatch(b!.id))!.nextAttemptAt.getTime())
    expect(await runTraceTick(d)).toMatchObject({ sent: 1 })
    expect(new Set(h.sent.map((s) => s.body)).size).toBe(1)
  })

  it('a 4xx refusal fails that batch, stops and shows why; it is never re-sent', async () => {
    const h = hub([400])
    const { d, clock } = deps({ read: table([tool('b', later(1000))]), hub: h })
    await runTraceTick(d)
    clock.t = later(1000 + SETTLE_MS + 1)
    expect(await runTraceTick(d)).toMatchObject({ failed: 1 })
    expect((await d.store.listBatches(1))[0]!.state).toBe('failed')
    expect((await d.store.settings()).lastError).toMatch(/HTTP 400/)
    clock.t = later(100 * SETTLE_MS)
    await runTraceTick(d)
    expect(h.sent).toHaveLength(1)
  })

  it('403 stops sending and says the hub refused this install; 401 asks to register again', async () => {
    const h = hub([401, 403])
    const { d, clock } = deps({ read: table([tool('b', later(1000))]), hub: h })
    await runTraceTick(d)
    clock.t = later(1000 + SETTLE_MS + 1)
    await runTraceTick(d)
    expect(h.unauthorized).toHaveBeenCalledTimes(1)
    clock.t = later(1000 + SETTLE_MS + 1 + backoffMs(1))
    await runTraceTick(d)
    expect((await d.store.settings()).lastError).toBe(REVOKED)
  })

  it('an open value Jev could not classify is withheld (not sent) and listed in the batch', async () => {
    const decide = vi.fn(async () => {
      throw new Error('no decision slot')
    })
    const h = hub()
    const { d, clock } = deps({ read: table([tool('b', later(1000), 'acme_crm.push')]), hub: h, decide })
    await runTraceTick(d)
    clock.t = later(1000 + SETTLE_MS + 1)
    await runTraceTick(d)
    const [b] = await d.store.listBatches(1)
    expect(b!.withheld).toEqual([{ field: 'tool', value: 'acme_crm.push' }])
    expect(h.sent[0]!.body).not.toContain('acme_crm')
  })

  it('not registered yet: the batch is built and kept, the reason shown, nothing sent', async () => {
    const h = { ...hub(), ready: async () => ({ ok: false as const, revoked: false, message: 'Registering failed' }) }
    const { d, clock } = deps({ read: table([tool('b', later(1000))]), hub: h })
    await runTraceTick(d)
    clock.t = later(1000 + SETTLE_MS + 1)
    expect(await runTraceTick(d)).toMatchObject({ skipped: 'not_ready', built: 1 })
    expect(h.sent).toHaveLength(0)
    expect((await d.store.settings()).lastError).toBe('Registering failed')
  })

  it('builds at most one batch per BUILD_EVERY_MS (the hub limit is shared with Contribute); the rest waits, nothing is lost', async () => {
    const rows = [tool('b', later(1000)), tool('c', later(SETTLE_MS * 3))]
    const h = hub()
    const { d, clock } = deps({ read: table(rows), hub: h })
    await runTraceTick(d)
    clock.t = later(2 * SETTLE_MS)
    expect(await runTraceTick(d)).toMatchObject({ built: 1, spans: 1 })
    clock.t = later(5 * SETTLE_MS)
    expect(await runTraceTick(d)).toMatchObject({ built: 0 })
    clock.t = later(2 * SETTLE_MS + BUILD_EVERY_MS)
    expect(await runTraceTick(d)).toMatchObject({ built: 1, spans: 1 })
    expect(h.sent).toHaveLength(2)
  })

  it('T5: an upgrade outcome and a module breakage are sent as Tier A spans — reason, from and the sentence never', async () => {
    const at = later(1000)
    const rows: Array<TraceSourceRow & { cursor: TraceCursor }> = [
      { source: 'upgrade', localId: 'u1', traceKey: null, at, step: 'watching', ok: false, rolledBack: true, release: 'eigenenterprise-0.5.48-0123456789ab', durationMs: null, cursor: { at, id: 'u1' } },
      { source: 'module_run', localId: 'm1', traceKey: null, at, cursor: { at, id: 'm1' } },
    ]
    const h = hub()
    const { d, clock } = deps({ read: table(rows), hub: h })
    await runTraceTick(d)
    clock.t = later(1000 + SETTLE_MS + 1)
    expect(await runTraceTick(d)).toMatchObject({ sent: 1, spans: 2 })
    const spans = JSON.parse(h.sent[0]!.body).spans
    expect(spans).toEqual([
      expect.objectContaining({ kind: 'upgrade', outcome: 'rolled_back', error_code: 'upgrade_step:watching', app_version: 'eigenenterprise-0.5.48-0123456789ab' }),
      expect.objectContaining({ kind: 'module_run', outcome: 'error', error_code: 'module_failed' }),
    ])
    expect(h.sent[0]!.body).not.toMatch(/reason|"from"|sentence/)
  })
})
