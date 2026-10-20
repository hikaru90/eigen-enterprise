import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { WEBSITE_MODULE_ID } from '../manifest'
import { GitHubApi, GitHubApiError, type LastCommit, type Repo } from './api'
import { asUserError, GitHubUserError, plainGitHubApiMessage } from './plain-errors'
import { parseGitHubRepo } from './repo-url'
import {
  type ConnectedRepo,
  type ConnectedRepoStore,
  defaultConnectedRepoStore,
  RepoAlreadyConnectedError,
} from './repos-store'
import { defaultGitHubStore, type GitHubStore } from './store'

/**
 * Connect a GitHub repository to the company (plan/github-connect.md).
 * Public repos by URL (read without auth); private repos through the company's
 * GitHub App installation (a short-lived installation token is minted from the
 * sealed App key per call, never stored). Connecting records what a later
 * deploy needs; it does not deploy and does not touch the server (D11).
 */

export type GitHubConnectToolDeps = {
  github?: GitHubStore
  repos?: ConnectedRepoStore
  api?: GitHubApi
}

const REPO_INPUT = z
  .string()
  .min(1)
  .max(300)
  .describe('A github.com link (https://github.com/owner/repo) or owner/repo')
const BRANCH = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/, 'a branch name')

const inspectInput = z.object({ repo: REPO_INPUT }).strict()
const connectInput = z.object({ repo: REPO_INPUT, branch: BRANCH }).strict()
const disconnectInput = z.object({ repo: REPO_INPUT, branch: BRANCH }).strict()

export type InspectedRepo = {
  repoId: number
  fullName: string
  htmlUrl: string
  cloneUrl: string
  visibility: 'public' | 'private'
  defaultBranch: string
  branches: string[]
  installationId: number | null
}

export type ConnectedRepoView = Omit<ConnectedRepo, 'createdAt'> & {
  createdAt: string
  lastCommit: LastCommit | null
  /** Plain words when the last commit could not be read (never a raw API error). */
  lastCommitError: string | null
}

export type GitHubConnectStatus = {
  connected: boolean
  installed: boolean
  appSlug: string | null
  /** Where the owner installs the app or adds more repositories to it. */
  manageUrl: string | null
}

function parseOrFail(raw: string): { owner: string; repo: string } {
  const parsed = parseGitHubRepo(raw)
  if (!parsed.ok) throw new GitHubUserError(parsed.message)
  return { owner: parsed.owner, repo: parsed.repo }
}

/** owner/repo for activity sentences; the raw input when it does not parse. */
function displayName(raw: string): string {
  const parsed = parseGitHubRepo(raw)
  return parsed.ok ? `${parsed.owner}/${parsed.repo}` : raw.trim()
}

const principalRef = (ctx: ToolContext) => `${ctx.principal.kind}:${ctx.principal.id}`

export function createGitHubConnectTools(deps: GitHubConnectToolDeps = {}): ToolDescriptor[] {
  const github = deps.github ?? defaultGitHubStore()
  const repos = deps.repos ?? defaultConnectedRepoStore()
  const api = deps.api ?? new GitHubApi()

  async function status(): Promise<GitHubConnectStatus> {
    const conn = await github.connection()
    if (!conn) return { connected: false, installed: false, appSlug: null, manageUrl: null }
    return {
      connected: true,
      installed: conn.installationId !== null,
      appSlug: conn.appSlug,
      manageUrl: `${conn.htmlUrl}/installations/new`,
    }
  }

  /** A fresh installation token, or null when no App is installed. */
  async function installationAuth(): Promise<{ token: string; installationId: number } | null> {
    const conn = await github.connection()
    if (!conn || conn.installationId === null) return null
    const creds = await github.credentials()
    try {
      return {
        token: await api.installationToken(conn.appId, creds.privateKeyPem, conn.installationId),
        installationId: conn.installationId,
      }
    } catch (err) {
      return asUserError(err, 'the GitHub App installation')
    }
  }

  async function inspect(raw: string): Promise<InspectedRepo> {
    const { owner, repo } = parseOrFail(raw)
    const name = `${owner}/${repo}`
    const auth = await installationAuth()
    let found: Repo | null = null
    let token: string | null = null
    if (auth) {
      try {
        found = await api.repo(owner, repo, auth.token)
        token = auth.token
      } catch (err) {
        if (!(err instanceof GitHubApiError && err.status === 404)) asUserError(err, name)
      }
    }
    if (!found) {
      try {
        found = await api.repo(owner, repo, null)
      } catch (err) {
        if (err instanceof GitHubApiError && err.status === 404) {
          throw new GitHubUserError(
            auth
              ? `GitHub has no public repository ${name}, and the GitHub App cannot see it. If it is private, add it to the app on GitHub (Add more repos on GitHub).`
              : `GitHub has no public repository ${name}. If it is private, connect GitHub first and give the app access to it.`,
            { cause: err },
          )
        }
        asUserError(err, name)
      }
    }
    let branches: string[]
    try {
      branches = await api.branches(owner, repo, token)
    } catch (err) {
      asUserError(err, `the branches of ${found.full_name}`)
    }
    return {
      repoId: found.id,
      fullName: found.full_name,
      htmlUrl: found.html_url,
      cloneUrl: found.clone_url,
      visibility: found.private ? 'private' : 'public',
      defaultBranch: found.default_branch,
      branches,
      installationId: found.private && auth ? auth.installationId : null,
    }
  }

  async function withLastCommit(rows: ConnectedRepo[]): Promise<ConnectedRepoView[]> {
    const needsToken = rows.some((r) => r.visibility === 'private')
    let auth: Awaited<ReturnType<typeof installationAuth>> = null
    let authError: string | null = null
    if (needsToken) {
      try {
        auth = await installationAuth()
        if (!auth)
          authError =
            'The GitHub App is not installed, so the last commit of a private repo cannot be read.'
      } catch (err) {
        authError =
          err instanceof GitHubUserError
            ? err.message
            : 'The GitHub App could not sign in to GitHub.'
      }
    }
    return Promise.all(
      rows.map(async (r): Promise<ConnectedRepoView> => {
        const base = { ...r, createdAt: r.createdAt.toISOString() }
        const [owner, name] = r.fullName.split('/')
        if (r.visibility === 'private' && !auth)
          return { ...base, lastCommit: null, lastCommitError: authError }
        try {
          const commit = await api.lastCommit(
            owner,
            name,
            r.branch,
            r.visibility === 'private' && auth ? auth.token : null,
          )
          return { ...base, lastCommit: commit, lastCommitError: null }
        } catch (err) {
          if (err instanceof GitHubApiError) {
            return {
              ...base,
              lastCommit: null,
              lastCommitError: plainGitHubApiMessage(err, `the branch ${r.branch}`),
            }
          }
          throw err
        }
      }),
    )
  }

  return [
    {
      name: 'website.github_list_repos',
      module: WEBSITE_MODULE_ID,
      summary:
        'The GitHub repositories connected to the company (repo, branch, visibility, last commit) and whether the GitHub App is connected and installed.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => ({
        github: await status(),
        repos: await withLastCommit(await repos.list()),
      }),
    },
    {
      name: 'website.github_available_repos',
      module: WEBSITE_MODULE_ID,
      summary:
        "Repositories the company's installed GitHub App can see (private ones included), to pick one to connect.",
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => {
        const auth = await installationAuth()
        if (!auth)
          throw new GitHubUserError(
            'GitHub is not connected yet. Connect GitHub first, then install the app on your repositories.',
          )
        let list: Repo[]
        try {
          list = await api.installationRepos(auth.token)
        } catch (err) {
          asUserError(err, 'the repositories of the GitHub App')
        }
        return list.map((r) => ({
          repoId: r.id,
          fullName: r.full_name,
          visibility: r.private ? ('private' as const) : ('public' as const),
          defaultBranch: r.default_branch,
        }))
      },
    },
    {
      name: 'website.github_inspect_repo',
      module: WEBSITE_MODULE_ID,
      summary:
        'Check a GitHub repository by link or owner/repo: whether it exists and can be read (public, or private through the GitHub App), its default branch and all branches.',
      auditClass: 'read',
      inputSchema: inspectInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => inspect(inspectInput.parse(input).repo),
    },
    {
      name: 'website.github_connect_repo',
      module: WEBSITE_MODULE_ID,
      summary:
        'Connect a GitHub repository and branch to the company so it can be deployed later. Public repos by link; private repos must be visible to the GitHub App. Does not deploy.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof connectInput>, output?: ConnectedRepo) =>
        `Connected the GitHub repo ${output?.fullName ?? displayName(input.repo)} (${input.branch})`,
      inputSchema: connectInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = connectInput.parse(input)
        const found = await inspect(i.repo)
        if (!found.branches.includes(i.branch)) {
          throw new GitHubUserError(`${found.fullName} has no branch named “${i.branch}”.`)
        }
        try {
          return await repos.add({
            repoId: found.repoId,
            fullName: found.fullName,
            branch: i.branch,
            htmlUrl: found.htmlUrl,
            cloneUrl: found.cloneUrl,
            visibility: found.visibility,
            installationId: found.installationId,
            connectedBy: principalRef(ctx),
          })
        } catch (err) {
          if (err instanceof RepoAlreadyConnectedError) {
            throw new GitHubUserError(`${found.fullName} (${i.branch}) is already connected.`, {
              cause: err,
            })
          }
          throw err
        }
      },
    },
    {
      name: 'website.github_disconnect_repo',
      module: WEBSITE_MODULE_ID,
      summary: 'Disconnect a GitHub repository branch from the company. Nothing on GitHub changes.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: (input: z.infer<typeof disconnectInput>) =>
        `Disconnected the GitHub repo ${displayName(input.repo)} (${input.branch})`,
      inputSchema: disconnectInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const i = disconnectInput.parse(input)
        const { owner, repo } = parseOrFail(i.repo)
        const removed = await repos.remove(`${owner}/${repo}`, i.branch)
        if (!removed) throw new GitHubUserError(`${owner}/${repo} (${i.branch}) is not connected.`)
        return { ...removed, createdAt: removed.createdAt.toISOString() }
      },
    },
  ]
}
