import { KernelError } from '$lib/kernel/errors'
import type { ModuleWorkloadPort } from '$lib/kernel/module-host/types'
import { EeClient, SubstrateUnavailableError } from '$lib/server/ee/client'

/**
 * The module host's ee port over ee's control API (plan/phase-upgrades-u2.md
 * §5; ee implements the verbs in ee/src/modules.ts). Without ee the kernel
 * fails loud with the plan's sentence — there is no other way to run modules.
 */
export const NO_EE_SENTENCE = 'Running modules needs the eigenEnterprise server (ee)'

async function onEe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) {
      throw new KernelError('not_configured', `${NO_EE_SENTENCE}: ${err.message}`)
    }
    throw err
  }
}

export function eeModuleWorkload(client: EeClient = new EeClient()): ModuleWorkloadPort {
  return {
    deploy: (r) => onEe(() => client.deployModule(r)),
    dryRun: (r) => onEe(() => client.dryRunModule(r)),
    list: () => onEe(() => client.modules()),
    get: (id) => onEe(() => client.module(id)),
    stop: (id, body) => onEe(() => client.stopModule(id, body)),
    start: (id, body) => onEe(() => client.startModule(id, body)),
    logs: (id, lines) => onEe(() => client.moduleLogs(id, lines)),
    remove: (id, body) => onEe(() => client.removeModule(id, body)),
  }
}
