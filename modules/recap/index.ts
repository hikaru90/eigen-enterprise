import type { RecapDeps } from './types'
import type { ToolDescriptor } from '$lib/kernel/types'
import { recapManifest } from './manifest'
import { createRecapScheduler, runDailyRecap, type RecapRunResult, type RecapScheduler } from './schedule'
import { createRecapRunNowTool } from './tools'

export { recapManifest }

export type RecapBoot = {
  manifest: typeof recapManifest
  runNowTool: ToolDescriptor
  /** Run-once execution bound to this boot's deps (run_now tool + scheduler share it). */
  runDaily: (now: Date) => Promise<RecapRunResult>
  scheduler: RecapScheduler
}

export type RecapModuleOptions = {
  /**
   * Activation gate for the scheduled path (fail closed — required, no
   * fallback). Normally `() => kernel.activations.get('recap')`.
   */
  isActive: () => Promise<boolean>
}

/**
 * Module composition: builds the recap runtime from injected ports (db,
 * telegram client, allowlist, event sink) and exposes the manifest + tool for
 * registration through the kernel's validated path (modules/index.ts). The
 * scheduler shares the exact run path of recap.run_now.
 */
export function createRecapModule(deps: RecapDeps, options: RecapModuleOptions): RecapBoot {
  const runDaily = (now: Date) => runDailyRecap(deps, now)
  const scheduler = createRecapScheduler({ isActive: options.isActive, runOnce: runDaily })
  return {
    manifest: recapManifest,
    runNowTool: createRecapRunNowTool(deps),
    runDaily,
    scheduler,
  }
}
