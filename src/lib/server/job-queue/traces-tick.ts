/**
 * The traces phone-home on the global job-queue tick (plan/traces-phone-home.md §3, T2): reads
 * new trace rows, builds and sends Tier A batches. A failure is logged loudly and never stops the
 * rest of the tick; the reason is also stored and shown in Settings → Company.
 */
export async function tickTraces(): Promise<void> {
  try {
    const { tracesTick } = await import('$lib/server/traces/live')
    await tracesTick()
  } catch (err) {
    console.error('[traces] background tick failed', { message: err instanceof Error ? err.message : String(err) })
  }
  try {
    const { traceHubRetentionTick } = await import('$lib/server/traces/live')
    await traceHubRetentionTick()
  } catch (err) {
    console.error('[trace-hub] retention failed', { message: err instanceof Error ? err.message : String(err) })
  }
}
