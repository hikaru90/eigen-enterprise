import { githubAppJwt } from './jwt'

/**
 * The slice of GitHub's REST API this module needs. `fetch` is injectable so
 * tests never touch the network; every non-2xx is a loud GitHubApiError that
 * carries the status (callers translate it into plain words for the owner).
 */

export type GitHubCredentials = {
  privateKeyPem: string
  webhookSecret: string
  clientSecret: string
}

export type ManifestConversion = {
  id: number
  slug: string
  client_id: string
  html_url: string
  pem: string
  webhook_secret: string
  client_secret: string
}

export type Repo = {
  id: number
  full_name: string
  default_branch: string
  private: boolean
  clone_url: string
  html_url: string
}

export type LastCommit = { sha: string; message: string; date: string | null }

const API = 'https://api.github.com'
const PER_PAGE = 100
/** Hard stop for pagination: 50 pages = 5000 items; beyond that something is wrong. */
const MAX_PAGES = 50

export class GitHubApiError extends Error {
  readonly rateLimited: boolean
  constructor(
    readonly status: number,
    readonly path: string,
    readonly githubMessage: string,
    readonly rateLimitReset: Date | null,
  ) {
    super(`GitHub ${path} → ${status}: ${githubMessage}`)
    this.name = 'GitHubApiError'
    this.rateLimited = rateLimitReset !== null
  }
}

/** `token` null = unauthenticated (public data only). */
type Auth = { token: string; kind: 'Bearer' | 'token' } | null

export class GitHubApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(path: string, auth: Auth, method = 'GET'): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'eigenEnterprise',
    }
    if (auth) headers.authorization = `${auth.kind} ${auth.token}`
    const res = await this.fetchImpl(`${API}${path}`, { method, headers })
    const text = await res.text()
    if (!res.ok) {
      let message = text.slice(0, 300)
      try {
        message = String((JSON.parse(text) as { message?: unknown }).message ?? message)
      } catch {
        // non-JSON error body: keep the raw (truncated) text
      }
      const exhausted =
        (res.status === 403 || res.status === 429) &&
        res.headers.get('x-ratelimit-remaining') === '0'
      const reset = res.headers.get('x-ratelimit-reset')
      throw new GitHubApiError(
        res.status,
        path,
        message,
        exhausted && reset ? new Date(Number(reset) * 1000) : null,
      )
    }
    return (text ? JSON.parse(text) : null) as T
  }

  /** Exchange the one-time code from the manifest flow for the new app's credentials. */
  async convertManifest(code: string): Promise<ManifestConversion> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new Error('invalid manifest code')
    return this.request<ManifestConversion>(`/app-manifests/${code}/conversions`, null, 'POST')
  }

  async installationToken(
    appId: number,
    privateKeyPem: string,
    installationId: number,
  ): Promise<string> {
    const jwt = githubAppJwt(appId, privateKeyPem)
    const out = await this.request<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { token: jwt, kind: 'Bearer' },
      'POST',
    )
    return out.token
  }

  /** Confirms the installation belongs to THIS app (the JWT is the app's own). */
  async installation(
    appId: number,
    privateKeyPem: string,
    installationId: number,
  ): Promise<{ id: number; account: { login: string } }> {
    return this.request(`/app/installations/${installationId}`, {
      token: githubAppJwt(appId, privateKeyPem),
      kind: 'Bearer',
    })
  }

  /** Every repository the installation can see (all pages). */
  async installationRepos(token: string): Promise<Repo[]> {
    const out: Repo[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.request<{ total_count: number; repositories: Repo[] }>(
        `/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
        { token, kind: 'token' },
      )
      out.push(...res.repositories)
      if (res.repositories.length < PER_PAGE || out.length >= res.total_count) return out
    }
    throw new Error(`the GitHub installation lists more than ${MAX_PAGES * PER_PAGE} repositories`)
  }

  /** One repository; `token` null reads it as the public would. */
  async repo(owner: string, name: string, token: string | null): Promise<Repo> {
    return this.request<Repo>(
      `/repos/${enc(owner)}/${enc(name)}`,
      token ? { token, kind: 'token' } : null,
    )
  }

  /** Every branch name of a repository (all pages). */
  async branches(owner: string, name: string, token: string | null): Promise<string[]> {
    const out: string[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.request<Array<{ name: string }>>(
        `/repos/${enc(owner)}/${enc(name)}/branches?per_page=${PER_PAGE}&page=${page}`,
        token ? { token, kind: 'token' } : null,
      )
      out.push(...res.map((b) => b.name))
      if (res.length < PER_PAGE) return out
    }
    throw new Error(`${owner}/${name} has more than ${MAX_PAGES * PER_PAGE} branches`)
  }

  async lastCommit(
    owner: string,
    name: string,
    branch: string,
    token: string | null,
  ): Promise<LastCommit> {
    const res = await this.request<{
      sha: string
      commit: { message: string; author: { date: string } | null }
    }>(
      `/repos/${enc(owner)}/${enc(name)}/commits/${encodeURIComponent(branch)}`,
      token ? { token, kind: 'token' } : null,
    )
    return {
      sha: res.sha,
      message: res.commit.message.split('\n')[0],
      date: res.commit.author?.date ?? null,
    }
  }
}

const enc = (s: string) => encodeURIComponent(s)
