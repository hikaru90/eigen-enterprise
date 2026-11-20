/**
 * A web app folder (plan/phase-drive-app-preview.md): a file fact, not
 * framework detection. A folder is one when its own top-level package.json is
 * valid JSON with a `dev` script (else a `start` script). Which lockfile sits
 * next to it decides how ee installs; none means Run will fail ("add a
 * lockfile"), shown up front so Run isn't silently hidden.
 */

/** In the order the preview contract names them. */
export const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const
export type Lockfile = (typeof LOCKFILES)[number]

export type WebApp = { script: 'dev' | 'start'; lockfile: Lockfile | null }

/** Snapshot limits from the contract: at most 200 MB unpacked and 20,000 files. */
export const SNAPSHOT_MAX_BYTES = 200 * 1024 * 1024
export const SNAPSHOT_MAX_FILES = 20_000
/** Directories a snapshot leaves out, at any depth: installs come fresh from the lockfile. */
export const SNAPSHOT_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git'])

const hasScript = (scripts: Record<string, unknown>, name: string) => typeof scripts[name] === 'string' && (scripts[name] as string).trim() !== ''

/**
 * What a package.json's text says, plus the folder's file names. Text that is
 * not JSON (or not an object) is no web app: null, the same as no package.json.
 */
export function webAppOf(packageJson: string, fileNames: readonly string[]): WebApp | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(packageJson)
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const scripts = (parsed as { scripts?: unknown }).scripts
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return null
  const s = scripts as Record<string, unknown>
  const script = hasScript(s, 'dev') ? 'dev' : hasScript(s, 'start') ? 'start' : null
  if (!script) return null
  return { script, lockfile: LOCKFILES.find((l) => fileNames.includes(l)) ?? null }
}
