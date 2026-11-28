import type { TraceValueChoice } from './decision-kinds'
import type { TraceSourceRow, ValueVerdicts } from './payload'
import { CORE_TOOL_NAMES, OPEN_VALUE_SHAPES, type OpenField } from './enums'

/**
 * The Jev gate for open values (plan/traces-phone-home.md T1b): before a batch is built, every
 * value of it that is not from a closed set we own is classified on the box by the decision kind
 * `traces.trace_value`. Verdicts are cached per (field, value), so each new module tool name or
 * model id is asked once. A failed classification is not cached and means the value is not sent
 * (the batch lists it as withheld); there is no raw fallback.
 */

export type OpenValue = { field: OpenField; value: string }

export type VerdictCache = {
  get(values: readonly OpenValue[]): Promise<Map<string, TraceValueChoice>>
  put(value: OpenValue, verdict: TraceValueChoice, at: Date): Promise<void>
}

export type ValueGateDeps = {
  cache: VerdictCache
  /** One Jev decision (decide() with traces.trace_value); throws when it could not decide. */
  decide: (value: OpenValue) => Promise<TraceValueChoice>
  now: () => Date
}

export const valueKey = (v: OpenValue) => `${v.field}\u0000${v.value}`

/** The distinct open values of the rows (closed-set and wrongly shaped values are never asked about). */
export function openValuesOf(rows: readonly TraceSourceRow[]): OpenValue[] {
  const seen = new Map<string, OpenValue>()
  const add = (field: OpenField, value: string) => {
    if (!OPEN_VALUE_SHAPES[field].test(value)) return
    const v = { field, value }
    if (!seen.has(valueKey(v))) seen.set(valueKey(v), v)
  }
  for (const r of rows) {
    if (r.source === 'tool_call' && !CORE_TOOL_NAMES.has(r.tool)) add('tool', r.tool)
    if (r.source === 'llm_call' && r.model != null) add('model', r.model)
  }
  return [...seen.values()]
}

export type ClassifyResult = {
  verdicts: ValueVerdicts
  failures: Array<OpenValue & { error: string }>
}

export async function classifyOpenValues(values: readonly OpenValue[], d: ValueGateDeps): Promise<ClassifyResult> {
  const known = await d.cache.get(values)
  const failures: ClassifyResult['failures'] = []
  for (const v of values) {
    if (known.has(valueKey(v))) continue
    try {
      const verdict = await d.decide(v)
      known.set(valueKey(v), verdict)
      await d.cache.put(v, verdict, d.now())
    } catch (err) {
      failures.push({ ...v, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return {
    verdicts: { verdict: (field, value) => known.get(valueKey({ field, value })) ?? 'unclassified' },
    failures,
  }
}

export function memoryVerdictCache(): VerdictCache {
  const m = new Map<string, TraceValueChoice>()
  return {
    async get(values) {
      const out = new Map<string, TraceValueChoice>()
      for (const v of values) {
        const hit = m.get(valueKey(v))
        if (hit) out.set(valueKey(v), hit)
      }
      return out
    },
    async put(v, verdict) {
      m.set(valueKey(v), verdict)
    },
  }
}
