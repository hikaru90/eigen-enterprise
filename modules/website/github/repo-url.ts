/**
 * Parses owner/repo out of a github.com repository link (https, or the SSH
 * forms git@github.com:owner/repo.git / ssh://git@github.com/owner/repo.git). This is structured
 * parsing of a URL format (host + path segments), not a guess at meaning.
 * Messages are plain words for the owner.
 */

export type ParsedRepo =
  { ok: true; owner: string; repo: string; branch: string | null } | { ok: false; message: string }

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const SHORT_FORM = /^[^/:\s.]+\/[^/:\s]+$/
const HOSTS = new Set(['github.com', 'www.github.com'])

const fail = (message: string): ParsedRepo => ({ ok: false, message })

/** The scp-like SSH form, user@host:path (no scheme). */
const SCP_FORM = /^([^@/:\s]+)@([^/:\s]+):(.*)$/

function sshSegments(user: string, host: string, path: string): string[] | ParsedRepo {
  if (!HOSTS.has(host.toLowerCase())) return fail('Only github.com repositories can be connected.')
  if (user !== 'git')
    return fail('Use the SSH address GitHub shows: git@github.com:owner/repo.git.')
  const segments = path.split('/').filter(Boolean)
  if (segments.length !== 2) return fail('That is not a valid GitHub owner/repo name.')
  return segments
}

function pathSegments(input: string): string[] | ParsedRepo {
  if (SHORT_FORM.test(input)) return input.split('/')
  const scp = SCP_FORM.exec(input)
  if (scp) return sshSegments(scp[1], scp[2], scp[3])
  if (/^ssh:\/\//i.test(input)) {
    let ssh: URL
    try {
      ssh = new URL(input)
    } catch {
      return fail('That is not a valid GitHub owner/repo name.')
    }
    return sshSegments(ssh.username, ssh.hostname, ssh.pathname)
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return fail('Paste a GitHub link like https://github.com/owner/repo.')
  }
  if (!HOSTS.has(url.hostname.toLowerCase()))
    return fail('Only github.com repositories can be connected.')
  if (url.protocol !== 'https:') return fail('Use the https:// link of the repository.')
  if (url.search || url.hash) return fail('Use the plain repository link, without ? or #.')
  try {
    return url.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s))
  } catch {
    return fail('That is not a valid GitHub owner/repo name.')
  }
}

export function parseGitHubRepo(raw: string): ParsedRepo {
  const input = raw.trim()
  if (!input) return fail('Paste a GitHub link like https://github.com/owner/repo.')
  const segments = pathSegments(input)
  if (!Array.isArray(segments)) return segments

  if (segments.length < 2) {
    return fail(
      'That link points to an account, not a repository. Use https://github.com/owner/repo.',
    )
  }
  const [owner, rawRepo, kind, ...rest] = segments
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo
  if (!OWNER.test(owner) || !NAME.test(repo) || repo === '.' || repo === '..') {
    return fail('That is not a valid GitHub owner/repo name.')
  }
  if (kind === undefined) return { ok: true, owner, repo, branch: null }
  if (kind === 'tree' && rest.length > 0) return { ok: true, owner, repo, branch: rest.join('/') }
  return fail('That link points inside a repository. Use https://github.com/owner/repo.')
}
