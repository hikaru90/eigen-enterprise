import { describe, expect, it, vi } from 'vitest'
import { tracesTraceValue } from './decision-kinds'
import { classifyOpenValues, memoryVerdictCache, openValuesOf } from './value-kind'
import type { TraceSourceRow } from './payload'

const at = new Date('2026-11-20T10:00:00Z')
const tool = (name: string): TraceSourceRow => ({ source: 'tool_call', localId: name, traceKey: null, at, tool: name, auditClass: 'read', ok: true, via: null, durationMs: 1 })
const llm = (model: string): TraceSourceRow => ({ source: 'llm_call', localId: model, traceKey: null, at, task: null, model, provider: 'openrouter', attempt: 1, outcome: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0, durationMs: 1 })

describe('traces.trace_value (plan/traces-phone-home.md T1b)', () => {
  it('is an enforced kind with the closed set usage_meta | personal_or_content', () => {
    expect(tracesTraceValue.choices).toEqual(['usage_meta', 'personal_or_content'])
    expect(tracesTraceValue.status).toBe('enforced')
  })

  it('asks only about values outside our closed sets, each distinct value once', () => {
    const pairs = openValuesOf([tool('memory.list_tasks'), tool('acme.sync'), tool('acme.sync'), llm('x/y'), llm('x/y')])
    expect(pairs).toEqual([
      { field: 'tool', value: 'acme.sync' },
      { field: 'model', value: 'x/y' },
    ])
  })

  it('caches each verdict, so a value is classified once across batches', async () => {
    const cache = memoryVerdictCache()
    const decide = vi.fn(async () => 'usage_meta' as const)
    const now = () => at
    await classifyOpenValues([{ field: 'tool', value: 'acme.sync' }], { cache, decide, now })
    const second = await classifyOpenValues([{ field: 'tool', value: 'acme.sync' }], { cache, decide, now })
    expect(decide).toHaveBeenCalledTimes(1)
    expect(second.verdicts.verdict('tool', 'acme.sync')).toBe('usage_meta')
  })

  it('a failed classification means the value is not sent: unclassified, reported, not cached, never a raw fallback', async () => {
    const cache = memoryVerdictCache()
    const decide = vi.fn(async () => {
      throw new Error('Jev unreachable')
    })
    const out = await classifyOpenValues([{ field: 'model', value: 'acme/secret-model' }], { cache, decide, now: () => at })
    expect(out.verdicts.verdict('model', 'acme/secret-model')).toBe('unclassified')
    expect(out.failures).toEqual([{ field: 'model', value: 'acme/secret-model', error: 'Jev unreachable' }])
    expect(await cache.get([{ field: 'model', value: 'acme/secret-model' }])).toEqual(new Map())
  })

  it('a value never asked about is unclassified', async () => {
    const out = await classifyOpenValues([], { cache: memoryVerdictCache(), decide: vi.fn(), now: () => at })
    expect(out.verdicts.verdict('tool', 'other.thing')).toBe('unclassified')
  })
})
