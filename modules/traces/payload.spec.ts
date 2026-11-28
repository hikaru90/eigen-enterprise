import { describe, expect, it } from 'vitest'
import { HUB_SPAN_KEYS, hubSpanV1, hubTraceBatchV1, toHubSpansV1, type TraceSourceRow, type ValueVerdicts } from './payload'

const at = (iso: string) => new Date(iso)
const TRACE = '0b9c1c55-4c5e-4a43-9a43-2f6a1c0c2d11'
const noOpen: ValueVerdicts = { verdict: () => 'unclassified' }
const ctx = (over: Partial<Parameters<typeof toHubSpansV1>[1]> = {}) => ({
  appVersion: '0.5.47',
  eeVersion: null,
  salt: 'install-salt',
  values: noOpen,
  ...over,
})

const run: TraceSourceRow = {
  source: 'run',
  localId: TRACE,
  traceKey: TRACE,
  at: at('2026-11-20T10:00:00Z'),
  triggerKind: 'mention',
  status: 'done',
  stopReason: null,
  costUsd: 0.0123456,
  durationMs: 2100,
}
const llm: TraceSourceRow = {
  source: 'llm_call',
  localId: 'c1',
  traceKey: TRACE,
  at: at('2026-11-20T10:00:01Z'),
  task: 'coworkers.turn',
  model: 'openai/gpt-4o-mini',
  provider: 'openrouter',
  attempt: 1,
  outcome: 'ok',
  tokensIn: 120,
  tokensOut: 30,
  costUsd: 0.0004,
  durationMs: 900,
}
const tool: TraceSourceRow = {
  source: 'tool_call',
  localId: 'e1',
  traceKey: TRACE,
  at: at('2026-11-20T10:00:02Z'),
  tool: 'memory.list_tasks',
  auditClass: 'read',
  ok: true,
  via: 'brain',
  durationMs: 40,
}

describe('toHubSpansV1 (plan/traces-phone-home.md §2 Tier A)', () => {
  it('turns a run, its model call and its tool call into one trace: run is the parent, offsets from the run start', () => {
    const { spans } = toHubSpansV1([run, llm, tool], ctx({ values: { verdict: () => 'usage_meta' } }))
    expect(spans).toHaveLength(3)
    const [r, l, t] = spans
    expect(new Set(spans.map((s) => s.trace_id)).size).toBe(1)
    expect(r!.trace_id).not.toBe(TRACE)
    expect(r).toMatchObject({ kind: 'run', run_kind: 'coworker:mention', parent_id: null, outcome: 'ok', start_offset_ms: 0, cost_usd: 0.0123, day: '2026-11-20' })
    expect(l).toMatchObject({ kind: 'llm_call', parent_id: r!.span_id, log_context: 'coworkers.turn', model: 'openai/gpt-4o-mini', provider_kind: 'openrouter', tokens_in: 120, tokens_out: 30, attempt: 1, start_offset_ms: 1000 })
    expect(t).toMatchObject({ kind: 'tool_call', parent_id: r!.span_id, tool: 'memory.list_tasks', audit_class: 'read', via: 'brain', outcome: 'ok', start_offset_ms: 2000 })
  })

  it('every span has exactly the Tier A key set', () => {
    const { spans } = toHubSpansV1([run, llm, tool], ctx())
    for (const s of spans) expect(Object.keys(s).sort()).toEqual([...HUB_SPAN_KEYS].sort())
  })

  it('the strict schema refuses any extra key', () => {
    const { spans } = toHubSpansV1([tool], ctx())
    expect(() => hubSpanV1.parse({ ...spans[0], context: 'hello' })).toThrow()
    expect(() => hubTraceBatchV1.parse({ v: 1, batch_id: TRACE, spans, note: 'x' })).toThrow()
  })

  it('is stable for one install: the same local trace maps to the same export id, another salt to another', () => {
    const a = toHubSpansV1([run], ctx()).spans[0]!
    const b = toHubSpansV1([run], ctx()).spans[0]!
    const c = toHubSpansV1([run], ctx({ salt: 'other' })).spans[0]!
    expect(a.trace_id).toBe(b.trace_id)
    expect(a.trace_id).not.toBe(c.trace_id)
  })

  it('a value outside our closed sets goes through the verdicts: usage_meta is kept, personal_or_content becomes `other`', () => {
    const custom = { ...tool, tool: 'acme_crm.sync_deals' }
    const keep = toHubSpansV1([custom], ctx({ values: { verdict: () => 'usage_meta' } }))
    expect(keep.spans[0]!.tool).toBe('acme_crm.sync_deals')
    const strip = toHubSpansV1([custom], ctx({ values: { verdict: () => 'personal_or_content' } }))
    expect(strip.spans[0]!.tool).toBe('other')
    expect(strip.withheld).toEqual([])
  })

  it('an unclassified open value is not sent (null) and is listed as withheld, never sent raw', () => {
    const custom = { ...llm, model: 'my-company-finetune-jane' }
    const out = toHubSpansV1([custom], ctx())
    expect(out.spans[0]!.model).toBeNull()
    expect(out.withheld).toEqual([{ field: 'model', value: 'my-company-finetune-jane' }])
    expect(JSON.stringify(out.spans)).not.toContain('jane')
  })

  it('closed-set values skip the verdicts entirely', () => {
    const asked: string[] = []
    toHubSpansV1([run, { ...llm, model: null }, tool], ctx({ values: { verdict: (f, v) => (asked.push(`${f}:${v}`), 'usage_meta') } }))
    expect(asked).toEqual([])
  })

  it('a failed tool, an errored run and a stopped run carry a closed error code', () => {
    const failed = toHubSpansV1([{ ...tool, ok: false }], ctx()).spans[0]!
    expect(failed).toMatchObject({ outcome: 'error', error_code: 'other' })
    const stopped = toHubSpansV1([{ ...run, status: 'stopped', stopReason: 'daily_cap' }], ctx()).spans[0]!
    expect(stopped).toMatchObject({ outcome: 'stopped', error_code: 'daily_cap' })
  })

  it('an upgrade outcome is a span of its own run (reason never present)', () => {
    const up: TraceSourceRow = { source: 'upgrade', localId: 'u1', traceKey: null, at: at('2026-11-21T03:00:00Z'), step: 'watching', ok: false, rolledBack: true, release: '0.5.48', from: '0.5.47', durationMs: 5000 }
    const s = toHubSpansV1([up], ctx()).spans[0]!
    expect(s).toMatchObject({ kind: 'upgrade', run_kind: 'upgrade', outcome: 'rolled_back', error_code: 'upgrade_step:watching', app_version: '0.5.48', ee_version: null, parent_id: null })
    expect(Object.keys(s)).not.toContain('reason')
  })
})
