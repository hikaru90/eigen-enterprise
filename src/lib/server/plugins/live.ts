import type { PluginGateDeps } from './gate'
import { CachedActivationStore } from '$lib/kernel/activation-cache'
import { MODULE_ACTIVATIONS_CHANNEL } from '$lib/kernel/db-stores'

/**
 * The plugin gate's live wiring: the process kernel's cached activation set
 * (no DB query per request), kept true across processes by LISTEN on the
 * kernel's switch announcements (started once, on first use). A reconnect of
 * the LISTEN connection drops the cache too: a switch announced while it was
 * down was not heard.
 */

let listening: Promise<void> | null = null

function listenForSwitches(cache: CachedActivationStore): Promise<void> {
  listening ??= (async () => {
    const { appSql } = await import('$lib/server/db')
    await appSql.listen(
      MODULE_ACTIVATIONS_CHANNEL,
      () => cache.invalidate(),
      () => cache.invalidate(),
    )
  })().catch((err: unknown) => {
    listening = null
    throw err
  })
  return listening
}

async function kernel() {
  const { appKernel } = await import('$lib/server/boot')
  const k = await appKernel()
  if (!(k.activations instanceof CachedActivationStore)) {
    // The gate reads per request: without the cache that is a DB query per request (fail loud).
    throw new Error('plugin gate: the kernel activation store is not cached (CachedActivationStore)')
  }
  await listenForSwitches(k.activations)
  return k
}

export const livePluginGateDeps: PluginGateDeps = {
  activations: async () => (await kernel()).activations.list(),
  pluginName: async (id) => {
    const manifest = (await kernel()).modules.get(id)
    return manifest && manifest.internal !== true ? manifest.name : undefined
  },
  canManage: async (userId) => {
    const { userCapabilities } = await import('$lib/server/auth/require-capability')
    return (await userCapabilities(userId))['modules.manage']
  },
  log: (line) => console.info(line),
}
