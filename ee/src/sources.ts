import { loadDeployKey, withDeployKey } from './deploy-keys.ts'
import { PATHS } from './paths.ts'
import type { SecretStore } from './secret-store.ts'
import { mustRun, type RunResult, type System } from './system.ts'

/**
 * Local git mirrors (D12): ee builds only from local git. A source provider
 * (the GitHub module) asks ee to fetch, either over https (public, or with a
 * short-lived token used for that one fetch via an http.extraHeader, never
 * written to disk) or over ssh with a deploy key ee holds sealed (written to a
 * 0600 temp file for that one fetch, pinned GitHub host keys).
 */
export type FetchInput = { name: string; url: string; ref: string; token?: string; deployKeyId?: string }

const SSH_URL = /^git@github\.com:([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\.git$/

export async function fetchSource(sys: System, i: FetchInput, keys?: Pick<SecretStore, 'all'>): Promise<string> {
  const mirror = `${PATHS.company}/sources/${i.name}.git`
  // No --prune: with one explicit refspec and a URL (not a named remote), git
  // prunes the very ref it fetches on every second run, leaving the mirror
  // without the branch (deploys failed "unknown revision" every other time).
  const fetchArgs = ['-C', mirror, 'fetch', '--quiet', '--no-tags', i.url, `+${i.ref}:refs/remotes/origin/${i.ref}`]

  let run: () => Promise<RunResult>
  if (i.deployKeyId !== undefined) {
    if (i.token !== undefined) throw new Error('a fetch uses either a token or a deploy key, not both')
    const m = SSH_URL.exec(i.url)
    if (!m) throw new Error(`a deploy-key fetch needs git@github.com:owner/repo.git, got ${i.url}`)
    if (!keys) throw new Error('a deploy-key fetch needs the secret store')
    const key = loadDeployKey(keys, i.deployKeyId, m[1]!)
    run = () => withDeployKey(sys, key, (env) => sys.run('git', fetchArgs, { env, timeoutMs: 300_000 }))
  } else {
    if (!i.url.startsWith('https://')) throw new Error(`an https fetch needs an https:// url, got ${i.url}`)
    const auth = i.token
      ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${i.token}`).toString('base64')}`]
      : []
    run = () => sys.run('git', [...auth, ...fetchArgs], { timeoutMs: 300_000 })
  }

  if (!(await sys.exists(mirror))) {
    await mustRun(sys, 'git', ['init', '-q', '--bare', mirror])
  }
  const r = await run()
  if (r.code !== 0) {
    // Never echo the auth header back.
    const detail = (r.stderr || r.stdout).replace(/Authorization: Basic [A-Za-z0-9+/=]+/g, 'Authorization: [redacted]')
    throw new Error(`git fetch ${i.url} ${i.ref} failed: ${detail.trim().slice(-1000)}`)
  }
  return (await mustRun(sys, 'git', ['-C', mirror, 'rev-parse', `refs/remotes/origin/${i.ref}`])).trim()
}
