import { statfs } from 'node:fs/promises'
import { basename } from 'node:path'
import { RESTORE_UNIT } from './backup/restore.ts'
import { CAPABILITIES } from './capabilities.ts'
import { EeUnreachableError, refusal, type Call } from './control-client.ts'
import { revertEe } from './ee-slots.ts'
import { loadJournal } from './journal.ts'
import { PATHS } from './paths.ts'
import { RELEASE_PUBLIC_KEY_PEM } from './release-key.ts'
import { loadMeta, metaDir, storeMeta } from './release-meta.ts'
import type { System } from './system.ts'
import { noFleetReport, noModuleCheck, noModuleImpact, releaseOf, type BackupResult, type TransactionDeps } from './upgrade.ts'
import { boxWatchProbe, DEFAULT_WATCH, type WatchLimits } from './upgrade-watch.ts'

/**
 * The upgrade transaction's hands on a real box (upgrade.ts TransactionDeps). The upgrade runs
 * outside the daemon (`ee upgrade`, or ee-upgrade.service), so what the daemon owns — backups,
 * the company repo and the edge for a rollback — it asks the daemon for over the control socket.
 */

const OS_TARBALL = /^eigenenterprise-\d+\.\d+\.\d+-[0-9a-f]{12}-linux-(?:x64|arm64)\.tar\.gz$/
/** How long the upgrade waits for an ee it put back to answer (the max-wait rule: one minute). */
const EE_BACK_MS = 60_000

export type BoxTxOptions = {
  sys: System
  call: Call
  watchLimits?: WatchLimits
  /** Free bytes on the filesystem holding a path (node's statfs on a box). */
  freeBytes?: (path: string) => Promise<number>
  sleep?: (ms: number) => Promise<void>
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function boxTransactionDeps(o: BoxTxOptions): TransactionDeps {
  const { sys, call } = o
  const sleep = o.sleep ?? sleepReal
  const psql = async (sql: string): Promise<string> => {
    const r = await sys.run('runuser', ['-u', 'postgres', '--', 'psql', '-d', 'os', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql])
    if (r.code !== 0) throw new Error(`psql: ${r.stderr.trim()}`)
    return r.stdout.trim()
  }
  const askRollback = async (reason: string): Promise<string> => {
    const { status, data } = await call('POST', '/v1/upgrade/rollback', { author: 'ee-upgrade', reason, automatic: true })
    if (status >= 400) throw new Error(refusal(data, status))
    return (data as { to: string }).to
  }
  return {
    freeBytes:
      o.freeBytes ??
      (async (path) => {
        const s = await statfs(path)
        return Number(s.bavail) * Number(s.bsize)
      }),
    databaseBytes: async () => {
      const n = Number(await psql(`SELECT pg_database_size('os')`))
      if (!Number.isFinite(n)) throw new Error('could not read the size of the os database')
      return n
    },
    capabilityInstalled: async (name) => {
      const c = (CAPABILITIES as Record<string, { path: string }>)[name]
      return c ? sys.exists(c.path) : false
    },
    busy: async () => {
      if ((await sys.run('systemctl', ['is-active', '--quiet', RESTORE_UNIT])).code === 0) return 'a restore is running; wait for it to finish'
      const raw = await sys.readFile(PATHS.restoreState)
      const job = raw ? (JSON.parse(raw) as { job?: { kind?: string; status?: string } }).job : undefined
      if (job?.kind === 'restore' && job.status === 'running') return 'a restore is running; wait for it to finish'
      return null
    },
    installedMeta: (release) => loadMeta(sys, release, RELEASE_PUBLIC_KEY_PEM),
    storeMeta: (release, files) => storeMeta(sys, release, files),
    offBoxBackup: async (): Promise<BackupResult> => {
      const status = await call('GET', '/v1/backups')
      if (status.status >= 400) throw new Error(refusal(status.data, status.status))
      if (!(status.data as { configured: boolean }).configured) return { configured: false }
      const { status: code, data } = await call('POST', '/v1/backups/run', { author: 'ee-upgrade', trigger: 'manual', wait: true })
      if (code >= 400) return { configured: true, ok: false, error: refusal(data, code) }
      const run = (data as { run: { id: string; status: string; error: string | null } }).run
      return run.status === 'succeeded' ? { configured: true, ok: true, id: run.id } : { configured: true, ok: false, error: run.error ?? `the backup ended ${run.status}` }
    },
    watchProbe: boxWatchProbe(sys),
    watchLimits: o.watchLimits ?? DEFAULT_WATCH,
    sleep,
    rollback: async (reason) => {
      try {
        return await askRollback(reason)
      } catch (err) {
        if (!(err instanceof EeUnreachableError)) throw err
      }
      // The new ee itself does not answer: put the ee before it back, then ask that one.
      const back = await revertEe(sys)
      const restart = await sys.run('systemctl', ['restart', 'ee.service'])
      if (restart.code !== 0) throw new Error(`ee was pointed back at ${back}, but ee.service did not restart: ${restart.stderr.trim()}`)
      const deadline = Date.now() + EE_BACK_MS
      for (;;) {
        try {
          return await askRollback(reason)
        } catch (err) {
          if (!(err instanceof EeUnreachableError) || Date.now() >= deadline) {
            throw new Error(`ee was pointed back at ${back}, which could not roll os back: ${(err as Error).message}`, { cause: err })
          }
        }
        await sleep(2000)
      }
    },
    keepReleases: async (keep) => void (await pruneReleases(sys, keep)),
    moduleImpact: noModuleImpact,
    moduleCheck: noModuleCheck,
    report: noFleetReport,
  }
}

/**
 * Keep the last two os releases on disk (§6.4 step 6): every other eigenEnterprise tarball, its
 * kept metadata and its unpacked release go. What a slot still names is never removed.
 */
export async function pruneReleases(sys: System, keep: string[]): Promise<string[]> {
  const kept = new Set(keep.map((k) => basename(k)))
  const ls = await sys.run('ls', ['-1', PATHS.releases])
  if (ls.code !== 0) throw new Error(`ls ${PATHS.releases}: ${ls.stderr.trim()}`)
  const entries = ls.stdout.split('\n').filter(Boolean)
  const keepIds = new Set<string>()
  for (const t of kept) keepIds.add((await sys.sha256File(`${PATHS.releases}/${t}`)).slice(0, 16))
  const os = (await loadJournal(sys)).workloads['os']
  for (const slot of [os?.slots.a, os?.slots.b]) if (slot) keepIds.add(slot.release)
  const keptReleases = new Set([...kept].map((t) => releaseOf(t)))
  const removed: string[] = []
  for (const e of entries) {
    const tarball = OS_TARBALL.test(e) && !kept.has(e)
    const meta = e.endsWith('.release') && !keptReleases.has(e.slice(0, -'.release'.length))
    if (!tarball && !meta) continue
    await sys.remove(meta ? metaDir(e.slice(0, -'.release'.length)) : `${PATHS.releases}/${e}`)
    removed.push(e)
  }
  const dirs = `${PATHS.workloads}/os/releases`
  const unpacked = await sys.run('ls', ['-1', dirs])
  if (unpacked.code === 0) {
    for (const id of unpacked.stdout.split('\n').filter(Boolean)) {
      if (id.includes('.partial-') || [...keepIds].some((k) => id === k || id.startsWith(`${k}-`))) continue
      await sys.remove(`${dirs}/${id}`)
      removed.push(`os/releases/${id}`)
    }
  }
  return removed
}
