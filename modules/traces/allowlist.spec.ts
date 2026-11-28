import { describe, expect, it } from 'vitest'
import { userJobTypeEnum } from '$lib/server/db/schema'
import { ERROR_CODES, JOB_TYPES, LOG_CONTEXTS, RUN_KINDS, SPAN_KINDS, SPAN_OUTCOMES, PROVIDER_KINDS, AUDIT_CLASSES, VIAS, CORE_TOOL_NAMES } from './enums'
import { toHubSpansV1, type TraceSourceRow } from './payload'

/** Every text a company could have put into a trace row: none may appear in a span. */
const PII = ['Jane Doe', 'jane@acme.example', 'https://crm.acme.example/deals/7', 'sk-live-ABCDEF0123456789']
const pii = PII.join(' ')

describe('Tier A allowlist (plan/traces-phone-home.md T1)', () => {
  it('rows seeded with names, emails, URLs and a pasted secret in every text column yield no string outside the enum sets', () => {
    const rows: TraceSourceRow[] = [
      { source: 'run', localId: pii, traceKey: pii, at: new Date('2026-11-20T10:00:00Z'), triggerKind: pii, status: pii, stopReason: pii, costUsd: 1, durationMs: 5 },
      { source: 'llm_call', localId: pii, traceKey: pii, at: new Date('2026-11-20T10:00:01Z'), task: pii, model: pii, provider: pii, attempt: 1, outcome: pii, tokensIn: 1, tokensOut: 1, costUsd: 0, durationMs: 1 },
      { source: 'tool_call', localId: pii, traceKey: pii, at: new Date('2026-11-20T10:00:02Z'), tool: pii, auditClass: pii, ok: false, via: pii, durationMs: 1 },
      { source: 'job', localId: pii, traceKey: pii, at: new Date('2026-11-20T10:00:03Z'), jobType: pii, ok: false, attempt: 2, durationMs: 1 },
      { source: 'upgrade', localId: pii, traceKey: null, at: new Date('2026-11-20T10:00:04Z'), step: pii, ok: false, rolledBack: false, release: pii, durationMs: 1 },
    ]
    // Even a gate that would keep everything cannot pass a value of the wrong shape.
    const { spans } = toHubSpansV1(rows, { appVersion: '0.5.47', eeVersion: null, salt: 's', values: { verdict: () => 'usage_meta' } })
    const allowed = new Set<string>([
      ...SPAN_KINDS, ...SPAN_OUTCOMES, ...RUN_KINDS, ...ERROR_CODES, ...PROVIDER_KINDS, ...AUDIT_CLASSES, ...VIAS,
      ...LOG_CONTEXTS, ...CORE_TOOL_NAMES, 'other', '0.5.47',
    ])
    const json = JSON.stringify(spans)
    for (const p of PII) for (const part of p.split(/[ @/.]/).filter((x) => x.length > 3)) expect(json).not.toContain(part)
    for (const s of spans) {
      for (const [k, v] of Object.entries(s)) {
        if (typeof v !== 'string') continue
        if (k === 'trace_id' || k === 'span_id' || k === 'parent_id') expect(v).toMatch(/^[0-9a-f-]{36}$/)
        else if (k === 'day') expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        else expect(allowed.has(v), `${k}=${v}`).toBe(true)
      }
    }
  })

  it('JOB_TYPES mirrors user_job_queue job types exactly', () => {
    expect([...JOB_TYPES].sort()).toEqual([...userJobTypeEnum].sort())
  })
})
