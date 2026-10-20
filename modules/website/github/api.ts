import { githubAppJwt } from './jwt'

/**
 * The slice of GitHub's REST API this module needs. `fetch` is injectable so
 * tests never touch the network; every non-2xx is a loud error with GitHub's message.
 */

export type GitHubCredentials = { privateKeyPem: string; webhookSecret: string; clientSecret: string }

export type ManifestConversion = {
  id: number
  slug: string
  client_id: string
  html_url: string
  pem: string
  webhook_secret: string
  client_secret: string
}

export type Repo = { full_name: string; default_branch: string; private: boolean; clone_url: string }

const API = 'https://api.github.com'

export class GitHubApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(path: string, init: { method?: string; token: string; tokenKind: 'Bearer' | 'token' }): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `${init.tokenKind} ${init.token}`,
        'user-agent': 'eigenEnterprise',
      },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : null) as T
  }

  /** Exchange the one-time code from the manifest flow for the new app's credentials. */
  async convertManifest(code: string): Promise<ManifestConversion> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new Error('invalid manifest code')
    const res = await this.fetchImpl(`${API}/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'eigenEnterprise' },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`GitHub manifest conversion → ${res.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as ManifestConversion
  }

  async installationToken(appId: number, privateKeyPem: string, installationId: number): Promise<string> {
    const jwt = githubAppJwt(appId, privateKeyPem)
    const out = await this.request<{ token: string }>(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      token: jwt,
      tokenKind: 'Bearer',
    })
    return out.token
  }

  /** Confirms the installation belongs to THIS app (the JWT is the app's own). */
  async installation(appId: number, privateKeyPem: string, installationId: number): Promise<{ id: number; account: { login: string } }> {
    return this.request(`/app/installations/${installationId}`, { token: githubAppJwt(appId, privateKeyPem), tokenKind: 'Bearer' })
  }

  async installationRepos(token: string): Promise<Repo[]> {
    const out = await this.request<{ repositories: Repo[] }>('/installation/repositories?per_page=100', {
      token,
      tokenKind: 'token',
    })
    return out.repositories
  }
}
