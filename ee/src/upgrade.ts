/**
 * Only a signed release runs: the release's SHA256SUMS must carry a valid
 * Ed25519 signature by the embedded release key (release-key.ts), and the
 * downloaded install.sh must match it, before it runs as root.
 *
 * `ee upgrade`: update this server over the air to the newest published
 * eigenEnterprise release, keeping everything (people, websites, repos,
 * domains, secrets, backups).
 *
 * An upgrade is a re-run of the release's own installer (`install.sh --from
 * <release>`), which verifies every download by checksum, keeps all state
 * (`ee bootstrap` is idempotent) and deploys the new app health-gated next to
 * the old one. Before that, a local safety copy is taken — the database and
 * ee's state — so a bad upgrade can always be rolled back on the box itself,
 * whether or not off-box backups are configured.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { AGE_REPAIR_SQL } from './age-repair.ts'
import { CompanyRepo } from './company-repo.ts'
import { PATHS } from './paths.ts'
import { RELEASE_PUBLIC_KEY_PEM, sha256Hex, trustedManifest } from './release-key.ts'
import type { System } from './system.ts'

/** The newest public release (GitHub serves `latest/download/<asset>` from the newest release). */
export const RELEASES_URL = 'https://github.com/hikaru90/eigen-enterprise/releases/latest/download'

export const UPGRADES_DIR = '/var/lib/ee/upgrades'
const KEEP_SAFETY_COPIES = 3
const RELEASE_NAME = /^eigenenterprise-\d+\.\d+\.\d+-[0-9a-f]{12}$/

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
export async function latestTarball(d: UpgradeDeps, from: string, arch: Arch): Promise<string> {
  return `${await latestName(d, from)}-linux-${arch}.tar.gz`
}

/** What an upgrade is doing now (Settings → Updates shows it; upgrade-job.ts). */
export type UpgradeStep = 'verifying' | 'safety-copy' | 'installing'

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

export async function upgrade(
  d: UpgradeDeps,
  opts: {
    from: string
    arch: Arch
    check: boolean
    nodeIp?: string
    /** The release the owner approved (Settings → Updates): any other release at `from` is refused. */
    expect?: string
    /** Each step as it starts (`safety-copy` carries the safety copy's directory). */
    onStep?: (step: UpgradeStep, detail: string) => Promise<void>
  },
): Promise<'up-to-date' | 'available' | 'upgraded'> {
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

  d.log('→ verifying the release signature')
  await opts.onStep?.('verifying', opts.from)
  const manifest = await signedManifest(d, opts.from)

  const dir = `${UPGRADES_DIR}/${d.now().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}`
  d.log(`→ taking a safety copy (database + ee state) in ${dir}`)
  await opts.onStep?.('safety-copy', dir)
  await safetyCopy(d, dir)

  d.log('→ running the release installer (keeps people, websites, repos, domains and secrets)')
  await opts.onStep?.('installing', dir)
  await d.download(`${opts.from}/install.sh`, `${dir}/install.sh`)
  try {
    manifest.check('install.sh', await d.sha256File(`${dir}/install.sh`))
  } catch (err) {
    await d.remove(`${dir}/install.sh`)
    throw new Error(`upgrade refused, nothing changed: ${(err as Error).message}`, { cause: err })
  }
  const code = await d.runLive('sh', [`${dir}/install.sh`, '--from', opts.from, ...(opts.nodeIp ? ['--node-ip', opts.nodeIp] : [])])
  if (code !== 0) {
    throw new Error(
      `the installer failed (exit ${code}). The app that was running stays live unless its health gate passed. ` +
        `Safety copy and rollback steps: ${dir}/ROLLBACK.txt`,
    )
  }
  d.log(`✓ upgraded to ${latest} — safety copy and rollback steps kept in ${dir}`)
  return 'upgraded'
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

/** The real UpgradeDeps on a box; `runLive` and `log` say where the installer's output goes. */
export function boxUpgradeDeps(sys: System, out: Pick<UpgradeDeps, 'runLive' | 'log'>): UpgradeDeps {
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
