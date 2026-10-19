import { PATHS } from './paths.ts'
import { mustRun, type System } from './system.ts'

/**
 * Local git mirrors (D12): ee builds only from local git. A source provider
 * (the GitHub module) asks ee to fetch; the token is used for that one fetch
 * via an http.extraHeader and never written to disk or the mirror's config.
 */
export async function fetchSource(
  sys: System,
  i: { name: string; url: string; ref: string; token?: string },
): Promise<string> {
  const mirror = `${PATHS.company}/sources/${i.name}.git`
  if (!(await sys.exists(mirror))) {
    await mustRun(sys, 'git', ['init', '-q', '--bare', mirror])
  }
  const auth = i.token
    ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${i.token}`).toString('base64')}`]
    : []
  const r = await sys.run(
    'git',
    [...auth, '-C', mirror, 'fetch', '--quiet', '--prune', '--no-tags', i.url, `+${i.ref}:refs/remotes/origin/${i.ref}`],
    { timeoutMs: 300_000 },
  )
  if (r.code !== 0) {
    // Never echo the auth header back.
    const detail = (r.stderr || r.stdout).replace(/Authorization: Basic [A-Za-z0-9+/=]+/g, 'Authorization: [redacted]')
    throw new Error(`git fetch ${i.url} ${i.ref} failed: ${detail.trim().slice(-1000)}`)
  }
  return (await mustRun(sys, 'git', ['-C', mirror, 'rev-parse', `refs/remotes/origin/${i.ref}`])).trim()
}
