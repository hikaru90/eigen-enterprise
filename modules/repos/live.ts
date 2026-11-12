import type { DriveSourcePort } from './drive-port'
import type { SyncLog, TickResult, TokenClientFactory } from './sync'
import { hostname } from 'node:os'
import { env } from '$lib/server/env/private-env'
import { redactForLog } from '$lib/server/observability/redact-for-log'
import { dbReposStore } from './db-store'
import { tokenSealKey } from './seal'
import { createReposService, type ReposService } from './service'

/**
 * Live wiring of the GitHub repos plugin: the Postgres store, the sealing key
 * from TENANT_MASTER_KEY (read at use time, fails loud without it), and the two
 * ports the composition root hands in at boot — Drive's source writer and the
 * GitHub token client — because a module never imports another module.
 */

export type ReposPorts = { drive: DriveSourcePort; client: TokenClientFactory }

let ports: ReposPorts | null = null
let live: ReposService | null = null

/** Called once by modules/index while it builds the kernel. */
export function provideReposPorts(p: ReposPorts): void {
  ports = p
  live = null
}

const log: SyncLog = (message, fields) => console.warn(message, redactForLog(fields))

/** This process's repos service. Throws when the composition root has not wired the ports. */
export function reposService(): ReposService {
  if (live) return live
  if (!ports) throw new Error('GitHub repos is not wired: modules/index must call provideReposPorts() while building the kernel')
  live = createReposService({
    store: dbReposStore(),
    drive: ports.drive,
    client: ports.client,
    key: () => tokenSealKey(env.TENANT_MASTER_KEY),
    now: () => new Date(),
    owner: `${hostname()}:${process.pid}`,
    log,
  })
  return live
}

/** One poller pass for the job-queue tick (every 60 s; each repo is due every 15 minutes). */
export async function reposTick(): Promise<TickResult> {
  const out = await reposService().tick()
  if (out.claimed > 0) console.info('[repos] tick', out)
  return out
}
