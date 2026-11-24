/**
 * Only a signed release runs: the release's SHA256SUMS must carry a valid
 * Ed25519 signature by the embedded release key (release-key.ts), and the
 * downloaded install.sh must match it, before it runs as root.
 *
 * `ee upgrade`: update this server over the air to the newest published
 * eigenEnterprise release, keeping everything (people, websites, repos,
 * domains, secrets, backups).
 *
 * The transaction (plan/phase-upgrades.md §6.4):
 *   1. preflight   signature, minFrom and the downgrade floor (release-meta.ts), the capabilities
 *                  the release needs, disk space, no restore running — refused with a sentence,
 *                  nothing changed. Module impact is computed here and only annotates.
 *   2. safety copy the database and ee's state, locally, plus an off-box backup when backups are
 *                  configured (a failed backup refuses the update).
 *   3+4. installer the release's own installer (`install.sh --from <release>`): ee upgrades itself
 *                  first (its A/B slot), then green comes up behind the health gate and the core
 *                  smoke (reconcile.ts); its preStart runs the expand-only migrations, so a failing
 *                  migration leaves blue serving.
 *   5. watch       after the cut-over (upgrade-watch.ts); the module check runs and only reports.
 *   6. rollback    a failed watch puts the release before back live through ee (`ee rollback`):
 *                  blue is still installed, no restore.
 *   7. report      the outcome goes to the job / journal (upgrade-job.ts) and the fleet sink.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { AGE_REPAIR_SQL } from './age-repair.ts'
import { CompanyRepo } from './company-repo.ts'
import { PATHS } from './paths.ts'
import { RELEASE_PUBLIC_KEY_PEM, sha256Hex, trustedManifest } from './release-key.ts'
import { fetchReleaseMeta, versionGate, type ReleaseMeta } from './release-meta.ts'
import type { System } from './system.ts'
import { watch, type WatchLimits, type WatchProbe } from './upgrade-watch.ts'

/** The newest public release (GitHub serves `latest/download/<asset>` from the newest release). */
export const RELEASES_URL = 'https://github.com/hikaru90/eigen-enterprise/releases/latest/download'

export const UPGRADES_DIR = '/var/lib/ee/upgrades'
const KEEP_SAFETY_COPIES = 3
const RELEASE_NAME = /^eigenenterprise-\d+\.\d+\.\d+-[0-9a-f]{12}$/
const RELEASE_TARBALL = /^(eigenenterprise-\d+\.\d+\.\d+-[0-9a-f]{12})-linux-(?:x64|arm64)\.tar\.gz$/

/**
 * The release a name refers to (eigenenterprise-<version>-<sha>), whether it is the release itself or
 * one CPU's tarball of it; null for anything else. A release is the same on every CPU.
 */
export function releaseOf(name: string): string | null {
  if (RELEASE_NAME.test(name)) return name
  return RELEASE_TARBALL.exec(name)?.[1] ?? null
}

export type Arch = 'x64' | 'arm64'

export type UpgradeDeps = {
  fetchText(url: string): Promise<string>
  download(url: string, dest: string): Promise<void>
  run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }>
  /** Runs with the terminal attached (the installer prints its own progress). */
  runLive(cmd: string, args: string[]): Promise<number>
  /** The release tarball the os workload runs now (basename), null on a server without one. */
  installed(): Promise<string | null>
  listUpgrades(): Promise<string[]>
  mkdirp(path: string): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
  /** sha256 (hex) of a local file. */
  sha256File(path: string): Promise<string>
  /** The release public key (PEM): RELEASE_PUBLIC_KEY_PEM in production. */
  releaseKeyPem: string
  now(): Date
  log(line: string): void
  /** The rest of the transaction (§6.4): preflight checks, the off-box backup, the watch, rollback, report. */
  tx: TransactionDeps
}

/** The release's SHA256SUMS, verified against the release key — before anything changes. */
export async function signedManifest(d: Pick<UpgradeDeps, 'fetchText' | 'releaseKeyPem'>, from: string) {
  const [manifest, sig] = [await d.fetchText(`${from}/SHA256SUMS`), await d.fetchText(`${from}/SHA256SUMS.sig`)]
  try {
    return trustedManifest(manifest, sig, d.releaseKeyPem)
  } catch (err) {
    throw new Error(`upgrade refused, nothing changed: ${(err as Error).message}`, { cause: err })
  }
}

/** The release at `from`, as its LATEST names it (eigenenterprise-<version>-<sha>). */
export async function latestName(d: Pick<UpgradeDeps, 'fetchText'>, from: string): Promise<string> {
  const name = (await d.fetchText(`${from}/LATEST`)).trim()
  if (!RELEASE_NAME.test(name)) {
    throw new Error(`${from}/LATEST is not a release name (got "${name.slice(0, 80)}") — is --from a release?`)
  }
  return name
}

/** The tarball for this CPU in the release at `from` (its LATEST names the release). */
export async function latestTarball(d: Pick<UpgradeDeps, 'fetchText'>, from: string, arch: Arch): Promise<string> {
  return `${await latestName(d, from)}-linux-${arch}.tar.gz`
}

/**
 * What an upgrade is doing now (Settings → Updates shows it; upgrade-job.ts):
 *   verifying     the preflight: signature, minFrom and the downgrade floor, capabilities, disk, no restore
 *   safety-copy   the local copy (database + ee state)
 *   backup        an off-box backup, when backups are configured
 *   installing    the release's installer: ee first, then green behind its health gate and the core smoke
 *   watching      the watch after the cut-over (upgrade-watch.ts)
 *   rolling-back  the watch failed: the release before is put back live
 */
export type UpgradeStep = 'verifying' | 'safety-copy' | 'backup' | 'installing' | 'watching' | 'rolling-back'

/** How an upgrade ended (the journal, Settings → Updates, Needs you and the fleet report get this). */
export type UpgradeOutcome = {
  /** The release it was to install (eigenenterprise-<version>-<sha>). */
  release: string
  /** The os release tarball that ran before (basename), null on a server without one. */
  from: string | null
  /** The step it ended in ('done' when it held). */
  step: UpgradeStep | 'done'
  ok: boolean
  /** Why it failed or was refused; null when it held. */
  reason: string | null
  /** The release before was put back live (the watch failed, or green never went live but was desired). */
  rolledBack: boolean
}

/**
 * Module impact for the assistant's brief (U2/U4 fill it): computed in the preflight from the
 * release's contract. It may only annotate, never refuse an update (§3: modules never hold one back).
 */
export type ModuleImpact = { module: string; status: 'ok' | 'deprecated' | 'broken'; note: string }
export type ModuleImpactHook = (i: { from: string | null; to: string }) => Promise<ModuleImpact[]>
/** The module check after the cut-over (§3): it only reports; a failing module never rolls the core back. */
export type ModuleCheckHook = (i: { release: string }) => Promise<ModuleImpact[]>
/**
 * The fleet's upgrade stats (§9.4: on by default, with a switch). No phone-home channel for
 * them exists yet: on a box this is the no-op sink, and the outcome stays on the box.
 */
export type UpgradeReportSink = (o: UpgradeOutcome) => Promise<void>

export const noModuleImpact: ModuleImpactHook = async () => []
export const noModuleCheck: ModuleCheckHook = async () => []
export const noFleetReport: UpgradeReportSink = async () => undefined

/** The disk an upgrade needs on /var/lib/ee beyond the database's safety copy: the release, copied and unpacked. */
export const UPGRADE_HEADROOM_BYTES = 3 * 1024 ** 3

/** The release assets that ship a capability the installer puts in place (install.sh). */
const SHIPPED: Record<string, (arch: Arch) => RegExp> = {
  chromium: (arch) => new RegExp(`^chromium-headless-shell-\\d+-linux-${arch}\\.tar\\.gz$`),
}
const LIVEKIT_ASSET = (arch: Arch) => new RegExp(`^livekit-server-\\d+\\.\\d+\\.\\d+-linux-${arch}\\.tar\\.gz$`)

export type BackupResult = { configured: false } | { configured: true; ok: true; id: string } | { configured: true; ok: false; error: string }

/** The transaction's checks and hands beyond the installer (plan/phase-upgrades.md §6.4). */
export type TransactionDeps = {
  /** Free bytes on the filesystem that holds `path`. */
  freeBytes(path: string): Promise<number>
  /** The os database's size in bytes (the safety copy dumps it). */
  databaseBytes(): Promise<number>
  /** Whether a capability (capabilities.ts) is installed on this server now. */
  capabilityInstalled(name: string): Promise<boolean>
  /** Why nothing may change now (a restore runs), or null. */
  busy(): Promise<string | null>
  /** The installed release's kept, verified metadata (release-meta.ts; the legacy stand-in when ee keeps none). */
  installedMeta(release: string): Promise<ReleaseMeta>
  /** Keep the new release's signed metadata next to its tarball (its floor guards `ee rollback`). */
  storeMeta(release: string, files: { sums: string; sig: string; meta: string }): Promise<void>
  /** An off-box backup now, when backups are configured; resolves once it finished. */
  offBoxBackup(): Promise<BackupResult>
  watchProbe: WatchProbe
  watchLimits: WatchLimits
  sleep(ms: number): Promise<void>
  /** Ask ee to put the release before back live (the `ee rollback` verb); resolves with the release that serves. */
  rollback(reason: string): Promise<string>
  /** Keep only these os release tarballs (and what was unpacked of them) on disk. */
  keepReleases(tarballs: string[]): Promise<void>
  moduleImpact: ModuleImpactHook
  moduleCheck: ModuleCheckHook
  report: UpgradeReportSink
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

async function safetyCopy(d: UpgradeDeps, dir: string): Promise<void> {
  await d.mkdirp(dir)
  const steps: Array<[string, string[]]> = [
    ['sh', ['-c', `runuser -u postgres -- pg_dump -Fc os > ${shellQuote(`${dir}/os.dump`)}`]],
    ['tar', ['-czf', `${dir}/ee-state.tgz`, '-C', '/', 'var/lib/ee/company', 'var/lib/ee/secrets.enc', 'etc/ee']],
  ]
  for (const [cmd, args] of steps) {
    const r = await d.run(cmd, args)
    if (r.code !== 0) throw new Error(`upgrade stopped, nothing changed: the safety copy failed (${cmd}): ${r.stderr.trim()}`)
  }
  await d.writeFile(`${dir}/ROLLBACK.txt`, rollbackSteps(dir))
  const copies = (await d.listUpgrades()).filter((n) => n !== dir.slice(UPGRADES_DIR.length + 1)).sort()
  const drop = copies.slice(0, Math.max(0, copies.length - (KEEP_SAFETY_COPIES - 1)))
  for (const name of drop) await d.remove(`${UPGRADES_DIR}/${name}`)
}

/** How to put the server back exactly as it was before this upgrade (written next to the copy). */
export function rollbackSteps(dir: string): string {
  return `Roll back to the state before the upgrade of ${dir.slice(UPGRADES_DIR.length + 1)} (run as root):

  systemctl stop ee.service
  systemctl stop $(systemctl list-units --plain --no-legend 'ee-*-?.service' | awk '{print $1}')
  tar -xzf ${dir}/ee-state.tgz -C /
  runuser -u postgres -- dropdb os
  runuser -u postgres -- pg_restore --create --exit-on-error --dbname=postgres ${dir}/os.dump
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d os <<'SQL'
${AGE_REPAIR_SQL}
SQL
  systemctl start ee.service

The restored company repo names the release that ran before, so ee redeploys it.
`
}

/** A refusal or failure, with the step it happened in (the outcome reports it). */
class StepError extends Error {
  constructor(
    readonly step: UpgradeStep,
    message: string,
    readonly rolledBack = false,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`

export type UpgradeOptions = {
  from: string
  arch: Arch
  check: boolean
  nodeIp?: string
  /** The release the owner approved (Settings → Updates): any other release at `from` is refused. */
  expect?: string
  /** Each step as it starts (`safety-copy` carries the safety copy's directory). */
  onStep?: (step: UpgradeStep, detail: string) => Promise<void>
  /** How it ended (also when refused in the preflight). */
  onOutcome?: (o: UpgradeOutcome) => Promise<void>
}

export async function upgrade(d: UpgradeDeps, opts: UpgradeOptions): Promise<'up-to-date' | 'available' | 'upgraded'> {
  const latest = await latestTarball(d, opts.from, opts.arch)
  if (opts.expect !== undefined && latest !== `${opts.expect}-linux-${opts.arch}.tar.gz`) {
    throw new Error(`upgrade refused, nothing changed: ${opts.from} holds ${latest}, not the approved ${opts.expect}`)
  }
  const current = await d.installed()
  if (current === latest) {
    d.log(`✓ this server already runs the newest release (${latest})`)
    return 'up-to-date'
  }
  d.log(`→ newest release: ${latest}`)
  d.log(`  this server runs: ${current ?? 'no release'}`)
  if (opts.check) return 'available'

  const release = releaseOf(latest)!
  let step: UpgradeStep = 'verifying'
  const enter = async (s: UpgradeStep, detail: string) => {
    step = s
    await opts.onStep?.(s, detail)
  }
  const outcome = async (o: Omit<UpgradeOutcome, 'release' | 'from'>) => {
    const full: UpgradeOutcome = { release, from: current, ...o }
    await opts.onOutcome?.(full)
    await d.tx.report(full)
  }
  try {
    await transaction(d, opts, { latest, release, current, enter })
  } catch (err) {
    const e = err instanceof StepError ? err : null
    await outcome({ step: e?.step ?? step, ok: false, reason: (err as Error).message, rolledBack: e?.rolledBack ?? false })
    throw err
  }
  await outcome({ step: 'done', ok: true, reason: null, rolledBack: false })
  return 'upgraded'
}

async function transaction(
  d: UpgradeDeps,
  opts: UpgradeOptions,
  t: { latest: string; release: string; current: string | null; enter: (s: UpgradeStep, detail: string) => Promise<void> },
): Promise<void> {
  const { latest, release, current, enter } = t
  const tx = d.tx
  const refuse = (why: string): never => {
    throw new StepError('verifying', `upgrade refused, nothing changed: ${why}`)
  }
  const plain = (err: Error) => err.message.replace(/^upgrade refused, nothing changed: /, '')

  // 1. Preflight: any failure is refused with a sentence, and nothing changes.
  d.log('→ checking the release (signature, versions, capabilities, disk)')
  await enter('verifying', opts.from)
  const busy = await tx.busy()
  if (busy) refuse(busy)
  const manifest = await signedManifest(d, opts.from).catch((err: Error) => refuse(plain(err)))
  const { meta, raw: metaRaw } = await fetchReleaseMeta(d, opts.from, manifest, release).catch((err: Error) => refuse(err.message))
  const currentRelease = current ? releaseOf(current) : null
  const currentMeta = currentRelease ? await tx.installedMeta(currentRelease).catch((err: Error) => refuse(err.message)) : null
  const gate = versionGate(currentMeta, meta)
  if (gate) refuse(gate)
  if (meta.legacy) d.log(`  ${release} is from before signed upgrade metadata: its downgrade floor is taken as ${meta.downgradeFloor}`)
  const listed = [...manifest.sums.keys()]
  for (const cap of meta.capabilities) {
    if (await tx.capabilityInstalled(cap)) continue
    const shipped = SHIPPED[cap]?.(opts.arch)
    if (!shipped || !listed.some((n) => shipped.test(n))) {
      refuse(`${release} needs the ${cap} capability, which this server lacks and the release does not ship for linux-${opts.arch}`)
    }
  }
  if (!meta.legacy && !listed.some((n) => LIVEKIT_ASSET(opts.arch).test(n))) refuse(`${release} does not ship livekit-server for linux-${opts.arch} (calls)`)
  const need = UPGRADE_HEADROOM_BYTES + (await tx.databaseBytes())
  const free = await tx.freeBytes(PATHS.root)
  if (free < need) refuse(`only ${gb(free)} free on ${PATHS.root}; the update needs ${gb(need)} (a safety copy of the database plus the new release)`)
  // Module impact is for the assistant's brief: it annotates, it never refuses.
  const impact = await tx
    .moduleImpact({ from: current, to: release })
    .catch((err: Error) => [{ module: '*', status: 'broken' as const, note: `the module impact could not be computed: ${err.message}` }])
  for (const m of impact) d.log(`  module ${m.module}: ${m.status} — ${m.note}`)

  // 2. Safety copy: the local copy, plus an off-box backup when backups are configured.
  const dir = `${UPGRADES_DIR}/${d.now().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}`
  d.log(`→ taking a safety copy (database + ee state) in ${dir}`)
  await enter('safety-copy', dir)
  try {
    await safetyCopy(d, dir)
  } catch (err) {
    throw new StepError('safety-copy', (err as Error).message, false, { cause: err })
  }
  await enter('backup', dir)
  const backup = await tx.offBoxBackup().catch((err: Error): BackupResult => ({ configured: true, ok: false, error: err.message }))
  if (!backup.configured) d.log('  no off-box backups are set up (Settings → Backups): the local safety copy is the only copy')
  else if (!backup.ok) throw new StepError('backup', `upgrade stopped, nothing changed: the off-box backup failed: ${backup.error}`)
  else d.log(`✓ off-box backup ${backup.id} finished`)

  // 3 + 4. The installer: ee first, then green (its preStart runs the migrations) behind the health gate and the core smoke.
  d.log('→ running the release installer (keeps people, websites, repos, domains and secrets)')
  await enter('installing', dir)
  await d.download(`${opts.from}/install.sh`, `${dir}/install.sh`)
  try {
    manifest.check('install.sh', await d.sha256File(`${dir}/install.sh`))
  } catch (err) {
    await d.remove(`${dir}/install.sh`)
    throw new StepError('installing', `upgrade refused, nothing changed: ${(err as Error).message}`, false, { cause: err })
  }
  if (metaRaw !== null) {
    const [sums, sig] = [await d.fetchText(`${opts.from}/SHA256SUMS`), await d.fetchText(`${opts.from}/SHA256SUMS.sig`)]
    await tx.storeMeta(release, { sums, sig, meta: metaRaw })
  }
  const code = await d.runLive('sh', [`${dir}/install.sh`, '--from', opts.from, ...(opts.nodeIp ? ['--node-ip', opts.nodeIp] : [])])
  const after = await d.installed()
  if (code !== 0 || after !== latest) {
    const why = code !== 0 ? `the installer failed (exit ${code})` : `the installer finished, but the company repo runs ${after ?? 'no release'}, not ${latest}`
    const copy = `Safety copy and rollback steps: ${dir}/ROLLBACK.txt`
    // Green never took traffic; when the company repo already names it, it goes back to what serves.
    if (after !== current && current !== null) {
      let serving: string
      try {
        serving = await tx.rollback(`${why}; ${latest} never went live`)
      } catch (err) {
        throw new StepError('installing', `${why}, and putting the company repo back to ${current} failed: ${(err as Error).message}. ${copy}`)
      }
      throw new StepError('installing', `${why}; ${serving} kept serving. ${copy}`, true)
    }
    throw new StepError('installing', `${why}. The app that was running stays live unless its health gate passed. ${copy}`)
  }

  // 5. The cut-over happened (the edge points at green): the watch, and the module check, which only reports.
  d.log(`→ ${latest} is live; watching it for ${Math.round(tx.watchLimits.durationMs / 60_000)} min (crash loops, edge 5xx, the job queue)`)
  await enter('watching', dir)
  const [why, modules] = await Promise.all([
    watch(tx.watchProbe, tx.watchLimits, { now: () => d.now(), sleep: (ms) => tx.sleep(ms) }),
    tx.moduleCheck({ release }).catch((err: Error) => [{ module: '*', status: 'broken' as const, note: `the module check could not run: ${err.message}` }]),
  ])
  for (const m of modules) d.log(`  module ${m.module}: ${m.status} — ${m.note}`)

  // 6. Rollback if the watch failed: the release before goes back live; no restore.
  if (why) {
    d.log(`✗ the watch failed: ${why}`)
    await enter('rolling-back', dir)
    let serving: string
    try {
      serving = await tx.rollback(`the watch after the update to ${release} failed: ${why}`)
    } catch (err) {
      throw new StepError(
        'rolling-back',
        `the update to ${release} failed its watch (${why}) and the rollback failed too: ${(err as Error).message}. Safety copy and rollback steps: ${dir}/ROLLBACK.txt`,
      )
    }
    throw new StepError('rolling-back', `the update to ${release} was rolled back: ${why}; ${serving} serves again`, true)
  }

  // The last two releases stay on disk: this one and the one before (the rollback target).
  await tx.keepReleases([latest, ...(current ? [current] : [])])
  d.log(`✓ upgraded to ${latest} — it held its watch; safety copy and rollback steps kept in ${dir}`)
}

/** This CPU, as release tarballs name it. */
export function hostArch(): Arch {
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch
  throw new Error(`unsupported CPU ${process.arch}`)
}

/** A release file: GET over http(s), or read from a directory source (an absolute path). */
async function getRelease(url: string): Promise<Buffer> {
  if (url.startsWith('/')) return readFile(url)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export const fetchReleaseText = async (url: string): Promise<string> => (await getRelease(url)).toString('utf8')

/** The os release tarball the company repo runs now (basename), null on a server without one. */
export async function installedOsRelease(sys: System, repo = new CompanyRepo(sys, PATHS.company)): Promise<string | null> {
  const os = (await repo.read()).workloads.find((w) => w.name === 'os')
  return os?.source.kind === 'release' ? basename(os.source.tarball) : null
}

/** The real UpgradeDeps on a box; `runLive` and `log` say where the installer's output goes, `tx` is box-tx.ts. */
export function boxUpgradeDeps(sys: System, out: Pick<UpgradeDeps, 'runLive' | 'log' | 'tx'>): UpgradeDeps {
  return {
    fetchText: fetchReleaseText,
    download: async (url, dest) => writeFile(dest, await getRelease(url), { mode: 0o600 }),
    run: (cmd, args) => sys.run(cmd, args, { timeoutMs: 1_800_000 }),
    installed: () => installedOsRelease(sys),
    listUpgrades: async () =>
      readdir(UPGRADES_DIR).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return []
        throw err
      }),
    mkdirp: (p) => sys.mkdirp(p, 0o700),
    writeFile: (p, content) => sys.writeFile(p, content, 0o600),
    remove: (p) => sys.remove(p),
    sha256File: async (p) => sha256Hex(await readFile(p)),
    releaseKeyPem: RELEASE_PUBLIC_KEY_PEM,
    now: () => new Date(),
    ...out,
  }
}
