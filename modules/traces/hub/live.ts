import type { TraceHubDeps } from './service'
import { dbHubTraceStore } from './db-store'
import { TRACE_HUB_MODULE_ID } from './manifest'

/** Live wiring of the hub's reads: the DB store over the app pool and the wall clock (ingest auth is wired in $lib/server/traces/hub-route). */

let deps: Pick<TraceHubDeps, 'store' | 'now'> | null = null

export async function traceHubReadDeps(): Promise<Pick<TraceHubDeps, 'store' | 'now'>> {
  if (deps) return deps
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  deps = { store: dbHubTraceStore(createScopedDrizzle(appSql)), now: () => Date.now() }
  return deps
}

/** Whether this install is the makers' trace hub (the owner switched the module on). */
export async function traceHubActive(): Promise<boolean> {
  const { appKernel } = await import('$lib/server/boot')
  return (await appKernel()).activations.get(TRACE_HUB_MODULE_ID)
}
