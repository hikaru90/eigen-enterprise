import type { TracesDeps } from './service'

/**
 * The traces module's live deps come from the composition root ($lib/server/traces/live): the
 * install's identity and hub transport are Contribute's, and a module never imports another.
 */
export async function tracesDeps(): Promise<TracesDeps> {
  const { liveTracesDeps } = await import('$lib/server/traces/live')
  return liveTracesDeps()
}
