import { sha256Hex } from '../../contracts/module-bundle'
import { KernelError } from '$lib/kernel/errors'
import type { ModuleBundles, ModuleStore } from '$lib/kernel/module-host/types'
import type { PublishPort } from './ports'
import type { ModuleRepo } from './repo'

/**
 * Where a deploy's bundle bytes come from (plan/phase-upgrades-u2.md §3, §6.1):
 * rebuilt from the module repo (deterministic), or — after a restore whose
 * module repo lacks the commit — re-fetched from the hub by the receipted
 * sha256. Either way the bytes must match the receipt; anything else fails loud.
 */
export function moduleBundles(repo: ModuleRepo, store: ModuleStore, hub: PublishPort): ModuleBundles {
  return {
    async bytes(id, commit) {
      const version = await store.version(id, commit)
      if (await repo.hasCommit(id, commit)) {
        const built = await repo.bundle(id, commit)
        if (version && built.sha256 !== version.bundleSha256) {
          throw new KernelError('module_unreceipted', `${id}@${commit.slice(0, 12)} in the module repo is not the receipted bundle`, {
            module: id,
            commit,
          })
        }
        return built.bytes
      }
      if (!version) {
        throw new KernelError('module_unreceipted', `${id}@${commit.slice(0, 12)} is neither in the module repo nor published`, {
          module: id,
          commit,
        })
      }
      const bytes = await hub.fetchBundle(version.bundleSha256)
      if (sha256Hex(bytes) !== version.bundleSha256) {
        throw new KernelError('module_unreceipted', `the hub's bundle for ${id}@${commit.slice(0, 12)} does not match its receipt`, {
          module: id,
          commit,
        })
      }
      return bytes
    },
  }
}
