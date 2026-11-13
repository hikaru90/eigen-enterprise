import type { HubDeps } from './service'
import { dbHubStore } from './db-store'
import { CONTRIBUTE_HUB_MODULE_ID } from './manifest'

/** Live wiring: the DB store over the app pool (company-level tables, no RLS) and the wall clock. */

let deps: HubDeps | null = null

export async function contributeHubDeps(): Promise<HubDeps> {
  if (deps) return deps
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  deps = { store: dbHubStore(createScopedDrizzle(appSql)), now: () => Date.now() }
  return deps
}

/** Whether this install is the central board (the owner switched the module on). */
export async function contributeHubActive(): Promise<boolean> {
  const { appKernel } = await import('$lib/server/boot')
  return (await appKernel()).activations.get(CONTRIBUTE_HUB_MODULE_ID)
}
