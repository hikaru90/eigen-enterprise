import type { TraceSourceRow } from '../../../../modules/traces/payload'
import type { TraceCursor } from '../../../../modules/traces/store'
import type { UpgradeTraceOutcome } from '$lib/server/ee/client'

/**
 * The upgrade source of the traces exporter (plan/traces-phone-home.md T5): ee's update ends,
 * after the cursor (time, journal id), as Tier A rows. ee already leaves out `reason` and `from`.
 * A server that does not run under ee (EE_STATE_DIR unset: the e2e harness, unit tests) has no
 * updates to report; under ee a failing control socket fails the read loudly.
 */
export function upgradeRowsFrom(outcomes: readonly UpgradeTraceOutcome[], after: TraceCursor, until: Date, limit: number): Array<TraceSourceRow & { cursor: TraceCursor }> {
  return outcomes
    .map((o) => ({ o, at: new Date(o.at) }))
    .filter(({ o, at }) => (at > after.at || (at.getTime() === after.at.getTime() && o.id > after.id)) && at < until)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.o.id.localeCompare(b.o.id))
    .slice(0, limit)
    .map(({ o, at }) => ({
      source: 'upgrade' as const,
      localId: o.id,
      traceKey: null,
      at,
      step: o.step,
      ok: o.ok,
      rolledBack: o.rolledBack,
      release: o.release,
      durationMs: null,
      cursor: { at, id: o.id },
    }))
}

export async function upgradeTraceRows(after: TraceCursor, until: Date, limit: number): Promise<Array<TraceSourceRow & { cursor: TraceCursor }>> {
  if (!process.env.EE_STATE_DIR?.trim()) return []
  const { EeClient } = await import('$lib/server/ee/client')
  const { outcomes } = await new EeClient().upgradeOutcomes()
  return upgradeRowsFrom(outcomes, after, until, limit)
}
