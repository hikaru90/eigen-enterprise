import { z } from 'zod'

/**
 * Where this server's releases come from (settings.releaseSource), recorded by
 * `ee bootstrap --release-source <install.sh --from>` so Settings → Updates can
 * look for a newer signed release without anyone typing a URL:
 *   github  the repo's GitHub releases (latest/download to look, the version's tag to install)
 *   dir     a directory on the box holding one release (copied there; the local box mounts /release)
 *   url     any other release URL (one release there, like a directory)
 * The signature check is the same for both (release-key.ts): the source only says where to read.
 */

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const releaseSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), repo: z.string().regex(GITHUB_REPO) }).strict(),
  z.object({ kind: z.literal('dir'), path: z.string().regex(/^\/[^\0]*$/) }).strict(),
  z.object({ kind: z.literal('url'), base: z.url({ protocol: /^https?$/ }) }).strict(),
])
export type ReleaseSource = z.infer<typeof releaseSourceSchema>

const GITHUB_RELEASES = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/(?:latest\/download|download\/v\d+\.\d+\.\d+)\/?$/
const RELEASE = /^eigenenterprise-(\d+\.\d+\.\d+)-[0-9a-f]{12}(?:-linux-(?:x64|arm64)\.tar\.gz)?$/

export function parseReleaseSource(from: string): ReleaseSource {
  const bad = () => new Error(`--release-source "${from}" must be an absolute directory or an http(s) release URL`)
  if (from.startsWith('/')) return { kind: 'dir', path: from.replace(/\/+$/, '') || '/' }
  let url: URL
  try {
    url = new URL(from)
  } catch {
    throw bad()
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw bad()
  if (url.search || url.hash) throw bad()
  const m = url.host === 'github.com' ? GITHUB_RELEASES.exec(url.pathname) : null
  if (m) {
    if (url.protocol !== 'https:') throw new Error(`--release-source "${from}" must be https`)
    return { kind: 'github', repo: m[1]! }
  }
  return { kind: 'url', base: from.replace(/\/+$/, '') }
}

/** Where the newest release's LATEST is read. */
export function newestFrom(s: ReleaseSource): string {
  return s.kind === 'github' ? `https://github.com/${s.repo}/releases/latest/download` : s.kind === 'dir' ? s.path : s.base
}

/** The release `name` itself (never "latest"): what an approved upgrade installs. */
export function pinnedFrom(s: ReleaseSource, name: string): string {
  if (s.kind === 'github') return `https://github.com/${s.repo}/releases/download/v${releaseVersion(name)}`
  return s.kind === 'dir' ? s.path : s.base
}

/** eigenenterprise-0.5.17-<sha>[-linux-<arch>.tar.gz] → 0.5.17 */
export function releaseVersion(name: string): string {
  const m = RELEASE.exec(name)
  if (!m) throw new Error(`"${name.slice(0, 80)}" is not a release name`)
  return m[1]!
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]! ? 1 : -1
  }
  return 0
}
