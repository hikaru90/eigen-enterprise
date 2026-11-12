/**
 * Background work a plugin owns (scheduled jobs, ticks) runs only while the
 * plugin is switched on (owner, 2026-11-12). Each tick asks once per piece of
 * work; a skipped run writes one log line naming the plugin and the work.
 * Reads the kernel's cached activation set — no DB query per tick.
 */

export type BackgroundDeps = {
  isActive: (pluginId: string) => Promise<boolean>
  pluginName: (pluginId: string) => Promise<string>
  log: (line: string) => void
}

async function liveDeps(): Promise<BackgroundDeps> {
  const { appKernel } = await import('$lib/server/boot')
  const kernel = await appKernel()
  return {
    isActive: (id) => kernel.activations.get(id),
    pluginName: async (id) => kernel.modules.get(id)?.name ?? id,
    log: (line) => console.info(line),
  }
}

/** Whether `work` of `pluginId` may run now; false = skipped (logged once for this run). */
export async function pluginOn(pluginId: string, work: string, deps?: BackgroundDeps): Promise<boolean> {
  const d = deps ?? (await liveDeps())
  if (await d.isActive(pluginId)) return true
  d.log(`[plugins] ${await d.pluginName(pluginId)} is switched off: skipped ${work}`)
  return false
}
