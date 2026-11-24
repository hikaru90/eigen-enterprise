import { basename } from 'node:path'
import type { CompanyRepo } from './company-repo.ts'
import type { Journal } from './journal.ts'
import { PATHS } from './paths.ts'
import { RELEASE_PUBLIC_KEY_PEM } from './release-key.ts'
import { loadMeta } from './release-meta.ts'
import type { System } from './system.ts'
import { outcomeSchema, type UpgradeServiceDeps } from './upgrade-job.ts'
import { installedOsRelease, type Arch, type UpgradeOutcome } from './upgrade.ts'

/**
 * The daemon's side of `ee rollback` and the upgrade report (upgrade-job.ts): what is on disk,
 * what the os slots run, and the desired-state change that puts blue back (daemon.ts wires it).
 */

const OS_TARBALL = /^eigenenterprise-\d+\.\d+\.\d+-[0-9a-f]{12}-linux-(?:x64|arm64)\.tar\.gz$/

type Daemon = {
  sys: System
  repo: CompanyRepo
  journal(): Journal
  change: (message: string, author: string, mutate: Parameters<CompanyRepo['commit']>[2]) => Promise<{ rev: string; reconcileError: string | null }>
  /** Why a restore holds the box now, or null. */
  restoreBusy(): Promise<string | null>
}

export function boxRollbackDeps(ee: Daemon, arch: Arch): UpgradeServiceDeps['rollback'] {
  const os = () => ee.journal().workloads['os']
  return {
    arch,
    installed: () => installedOsRelease(ee.sys, ee.repo),
    osTarballs: async () => {
      const r = await ee.sys.run('ls', ['-1', PATHS.releases])
      if (r.code !== 0) throw new Error(`ls ${PATHS.releases}: ${r.stderr.trim()}`)
      return r.stdout.split('\n').filter((n) => OS_TARBALL.test(n))
    },
    inactiveSlotRelease: async () => {
      const w = os()
      if (!w?.active) return null
      return w.slots[w.active === 'a' ? 'b' : 'a']?.release ?? null
    },
    sha256Of: (tarball) => ee.sys.sha256File(`${PATHS.releases}/${basename(tarball)}`),
    meta: (release) => loadMeta(ee.sys, release, RELEASE_PUBLIC_KEY_PEM),
    restoreBusy: () => ee.restoreBusy(),
    switchOs: async (tarball, sha256, author, message) => {
      const path = `${PATHS.releases}/${basename(tarball)}`
      const { reconcileError } = await ee.change(message, author, (s) => {
        const w = s.workloads.find((x) => x.name === 'os')
        if (!w) throw new Error('the company repo has no os workload')
        return { ...s, workloads: s.workloads.map((x) => (x.name === 'os' ? { ...x, source: { kind: 'release' as const, tarball: path, sha256 } } : x)) }
      })
      return reconcileError
    },
    liveOsRelease: async () => {
      const w = os()
      return w?.active ? (w.slots[w.active]?.release ?? null) : null
    },
  }
}

/** The newest upgrade end in the journal (job or CLI path), null when none was journalled since U3. */
export function lastUpgradeOutcome(journal: Journal): UpgradeOutcome | null {
  for (let i = journal.events.length - 1; i >= 0; i--) {
    const e = journal.events[i]!
    if (e.type !== 'upgrade.succeeded' && e.type !== 'upgrade.failed') continue
    const parsed = outcomeSchema.safeParse(e.data['outcome'])
    if (parsed.success) return parsed.data
  }
  return null
}
