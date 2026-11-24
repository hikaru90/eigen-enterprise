import { legacyMeta, versionGate, type ReleaseMeta } from './release-meta.ts'
import { compareVersions, releaseVersion } from './release-source.ts'
import { releaseOf, type Arch } from './upgrade.ts'

/**
 * `ee rollback` (plan/phase-upgrades.md §6.4 step 6): put the os release that ran before back
 * live. Blue is still on disk (ee keeps the last two releases), so this is a desired-state change
 * — the company repo's os workload goes back to blue's tarball — and the ordinary blue/green
 * deploy brings it up behind its health gate and points the edge back at it. No restore, no lost
 * data: blue runs on the expanded schema. Going below the downgrade floor of what runs now is
 * refused; that needs a restore from the safety copy.
 *
 * Only the os workload's source goes back. Everything else in the company repo stays as it is
 * (a domain or secret added since is kept), and so does livekit (an older os talks to it the same).
 */

export type RollbackDeps = {
  arch: Arch
  /** The os release tarball the company repo names now (basename). */
  installed(): Promise<string | null>
  /** The os release tarballs on disk (basenames in /var/lib/ee/releases). */
  osTarballs(): Promise<string[]>
  /** The release id (sha256 prefix) of the os slot that is not live: blue, after an upgrade. */
  inactiveSlotRelease(): Promise<string | null>
  sha256Of(tarball: string): Promise<string>
  /** A release's kept, verified metadata (release-meta.ts loadMeta). */
  meta(release: string): Promise<ReleaseMeta>
}

/** What a rollback would do now: from what, to which release, or why not (a plain sentence). */
export type RollbackPlan = { from: string | null; to: string | null; refused: string | null }

export async function planRollback(d: RollbackDeps, to?: string): Promise<RollbackPlan> {
  const from = await d.installed()
  const no = (refused: string): RollbackPlan => ({ from, to: null, refused })
  if (!from) return no('this server runs no os release to roll back from')
  const fromRelease = releaseOf(from)
  if (!fromRelease) return no(`${from} is not a release ee can roll back from`)
  const others = (await d.osTarballs()).filter((t) => t !== from && t.endsWith(`-linux-${d.arch}.tar.gz`) && releaseOf(t) !== null).sort()
  let target: string
  if (to !== undefined) {
    const hit = others.find((t) => releaseOf(t) === releaseOf(to) || t === to)
    if (!hit) return no(`${to} is not on this server; it keeps ${others.length ? others.join(', ') : 'no other release'} besides ${from}`)
    target = hit
  } else if (others.length === 0) {
    return no(`no earlier release is on this server to roll back to (it keeps the last two; only ${from} is here)`)
  } else if (others.length === 1) {
    target = others[0]!
  } else {
    // More than one kept (from before ee pruned): the one the other slot ran is blue.
    const inactive = await d.inactiveSlotRelease()
    const blue: string[] = []
    if (inactive) for (const t of others) if ((await d.sha256Of(t)).startsWith(inactive)) blue.push(t)
    if (blue.length !== 1) return no(`more than one earlier release is on this server; say which (--to): ${others.map((t) => releaseOf(t)).join(', ')}`)
    target = blue[0]!
  }
  const targetRelease = releaseOf(target)!
  if (compareVersions(releaseVersion(targetRelease), releaseVersion(fromRelease)) > 0) {
    return no(`${targetRelease} is newer than ${fromRelease}: that is an update (ee upgrade), not a rollback`)
  }
  let fromMeta: ReleaseMeta
  try {
    fromMeta = await d.meta(fromRelease)
  } catch (err) {
    return no((err as Error).message)
  }
  const gate = versionGate(fromMeta, legacyMeta(targetRelease))
  if (gate) return no(gate)
  return { from, to: target, refused: null }
}
