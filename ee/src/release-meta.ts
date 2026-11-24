import { z } from 'zod'
import { PATHS } from './paths.ts'
import { sha256Hex, trustedManifest } from './release-key.ts'
import { compareVersions, releaseVersion } from './release-source.ts'

/**
 * What a release says about upgrading to and away from it (plan/phase-upgrades.md §6.4 step 1),
 * as the signed asset UPGRADE.json (scripts/upgrade-meta.mjs writes it, scripts/release.sh lists
 * it in SHA256SUMS):
 *
 *   downgradeFloor  the oldest release a box may go back to from this one (scripts/downgrade-floor.mjs;
 *                   the same value as the DOWNGRADE_FLOOR asset /ops reads)
 *   minFrom         the oldest release that may upgrade straight to this one
 *   capabilities    the system programs the release's os workload needs (its ee.json)
 *
 * ee checks these on the box itself, not only in /ops. A release since META_REQUIRED_SINCE
 * without a signed UPGRADE.json is refused. A release from before carries none: ee treats it as
 * floor = its own version (nothing older is reachable from it), no minFrom, and no capabilities
 * beyond what its own installer installs.
 */

export const UPGRADE_META = 'UPGRADE.json'
/** The first release whose build writes UPGRADE.json (U3). */
export const META_REQUIRED_SINCE = '0.5.40'

const RELEASE_NAME = /^eigenenterprise-\d+\.\d+\.\d+-[0-9a-f]{12}$/
const VERSION = /^\d+\.\d+\.\d+$/

/** Tolerant reader: fields a later release adds are ignored, the ones ee needs are required. */
export const upgradeMetaSchema = z.object({
  release: z.string().regex(RELEASE_NAME),
  downgradeFloor: z.string().regex(VERSION),
  minFrom: z.string().regex(VERSION),
  capabilities: z.array(z.string().min(1).max(64)).max(32),
})

export type ReleaseMeta = {
  release: string
  version: string
  downgradeFloor: string
  minFrom: string | null
  capabilities: string[]
  /** A release from before UPGRADE.json: the values are ee's stand-ins, not the release's. */
  legacy: boolean
}

type Manifest = ReturnType<typeof trustedManifest>

/** The stand-in for a release from before UPGRADE.json (or one ee has no signed copy of). */
export function legacyMeta(release: string): ReleaseMeta {
  const version = releaseVersion(release)
  return { release, version, downgradeFloor: version, minFrom: null, capabilities: [], legacy: true }
}

/** Parse UPGRADE.json for `release` (already checked against the signed manifest). */
export function parseMeta(raw: string, release: string): ReleaseMeta {
  let parsed: z.infer<typeof upgradeMetaSchema>
  try {
    parsed = upgradeMetaSchema.parse(JSON.parse(raw))
  } catch (err) {
    throw new Error(`${release}'s ${UPGRADE_META} is not valid: ${(err as Error).message.split('\n')[0]}`, { cause: err })
  }
  if (parsed.release !== release) throw new Error(`${release}'s ${UPGRADE_META} describes ${parsed.release}`)
  const version = releaseVersion(release)
  if (compareVersions(parsed.downgradeFloor, version) > 0) throw new Error(`${release}'s downgrade floor ${parsed.downgradeFloor} is newer than the release itself`)
  if (compareVersions(parsed.minFrom, version) > 0) throw new Error(`${release}'s minFrom ${parsed.minFrom} is newer than the release itself`)
  return { release, version, downgradeFloor: parsed.downgradeFloor, minFrom: parsed.minFrom, capabilities: parsed.capabilities, legacy: false }
}

/** The release's UPGRADE.json at `from`, checked against its signed manifest; the legacy stand-in for an old release. */
export async function fetchReleaseMeta(
  d: { fetchText(url: string): Promise<string> },
  from: string,
  manifest: Manifest,
  release: string,
): Promise<{ meta: ReleaseMeta; raw: string | null }> {
  if (!manifest.sums.has(UPGRADE_META)) {
    if (compareVersions(releaseVersion(release), META_REQUIRED_SINCE) >= 0) {
      throw new Error(`${release} carries no signed ${UPGRADE_META} (its downgrade floor and minFrom); every release since ${META_REQUIRED_SINCE} must`)
    }
    return { meta: legacyMeta(release), raw: null }
  }
  const raw = await d.fetchText(`${from}/${UPGRADE_META}`)
  manifest.check(UPGRADE_META, sha256Hex(raw))
  return { meta: parseMeta(raw, release), raw }
}

/**
 * Whether a box running `current` may move to `target`, or why not (a plain sentence):
 * forward needs current ≥ target.minFrom, back needs target ≥ current's downgrade floor.
 */
export function versionGate(current: ReleaseMeta | null, target: ReleaseMeta): string | null {
  if (!current) return null
  const c = compareVersions(target.version, current.version)
  if (c > 0 && target.minFrom && compareVersions(current.version, target.minFrom) < 0) {
    return `${target.release} can only be installed on a server that runs ${target.minFrom} or newer; this one runs ${current.version}: install a release in between first`
  }
  if (c < 0 && compareVersions(target.version, current.downgradeFloor) < 0) {
    return `${target.version} is below the downgrade floor ${current.downgradeFloor} of ${current.release} (it changed what ${target.version} runs on); going back that far needs a restore from the safety copy`
  }
  return null
}

/** Where ee keeps an installed release's signed metadata (next to its tarball), so it is re-verifiable later. */
export const metaDir = (release: string) => `${PATHS.releases}/${release}.release`

type MetaFiles = {
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string, mode?: number): Promise<void>
  mkdirp(path: string, mode?: number): Promise<void>
}

/** Keep the release's signed SHA256SUMS (+ .sig) and its UPGRADE.json on the box. */
export async function storeMeta(f: Pick<MetaFiles, 'writeFile' | 'mkdirp'>, release: string, files: { sums: string; sig: string; meta: string }): Promise<void> {
  const dir = metaDir(release)
  await f.mkdirp(dir, 0o700)
  await f.writeFile(`${dir}/SHA256SUMS`, files.sums, 0o600)
  await f.writeFile(`${dir}/SHA256SUMS.sig`, files.sig, 0o600)
  await f.writeFile(`${dir}/${UPGRADE_META}`, files.meta, 0o600)
}

/**
 * An installed release's metadata, verified again against the release key; the legacy
 * stand-in when ee keeps none for it. A kept copy that does not verify fails loud.
 */
export async function loadMeta(f: Pick<MetaFiles, 'readFile'>, release: string, releaseKeyPem: string): Promise<ReleaseMeta> {
  const dir = metaDir(release)
  const [sums, sig, raw] = [await f.readFile(`${dir}/SHA256SUMS`), await f.readFile(`${dir}/SHA256SUMS.sig`), await f.readFile(`${dir}/${UPGRADE_META}`)]
  if (sums === null && sig === null && raw === null) return legacyMeta(release)
  if (sums === null || sig === null || raw === null) throw new Error(`the kept metadata of ${release} in ${dir} is incomplete`)
  try {
    const manifest = trustedManifest(sums, sig.trim(), releaseKeyPem)
    manifest.check(UPGRADE_META, sha256Hex(raw))
  } catch (err) {
    throw new Error(`the kept metadata of ${release} in ${dir} does not verify: ${(err as Error).message}`, { cause: err })
  }
  return parseMeta(raw, release)
}
