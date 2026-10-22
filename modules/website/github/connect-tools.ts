import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { EeClient, SubstrateError, SubstrateUnavailableError } from '$lib/server/ee/client'
import { requireHuman } from '$lib/server/ee/human'
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
 *
 * Private repos without the App: a read-only DEPLOY KEY per repo. ee owns the
 * key pair (generated and sealed on the server, used for one git call at a
 * time with GitHub's pinned host keys); this side only ever sees the public
 * key and ee's key id. Creating or deleting a key changes the server's secret
 * store, so those are human-only (D11: requireHuman) — on the page they are
 * the owner's own click.
 */

/** ee's deploy-key verbs (src/lib/server/ee/client.ts); a seam so tests need no socket. */
export type DeployKeyEe = Pick<EeClient, 'createDeployKey' | 'checkDeployKey' | 'deleteDeployKey'>

export type GitHubConnectToolDeps = {
  github?: GitHubStore
  repos?: ConnectedRepoStore
  api?: GitHubApi
  ee?: DeployKeyEe
}

export const EE_UNAVAILABLE_MESSAGE =
  "Private repos need the server's deploy agent. This copy of Eigen Enterprise is not running on a server set up with ee, so it cannot hold a deploy key."
export const KEY_NOT_ACCEPTED_MESSAGE =
  "GitHub didn't accept the key yet — check it was added to this repo (Settings → Deploy keys)."
const DEPLOY_KEY_LAST_COMMIT =
  'Read through a deploy key; the latest commit shows once it is deployed.'

/**
 * GitHub answers 404 to any read of a repo this server cannot see: it is
 * private (or gone). Structured, not a message to match: when no GitHub App
 * is installed, the page answers this by offering the deploy-key flow.
 */
export class RepoNotVisibleError extends GitHubUserError {
  constructor(
    readonly fullName: string,
    /** True when the GitHub App is installed: the repo has to be added to it on GitHub instead. */
    readonly appInstalled: boolean,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'RepoNotVisibleError'
  }
}

const REPO_INPUT = z
  .string()
  .min(1)
  .max(300)
  .describe('A github.com link (https://github.com/owner/repo) or owner/repo')
const BRANCH = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/, 'a branch name')

const KEY_ID = z.string().regex(/^dk_[a-f0-9]{24}$/, 'a deploy key id')

const inspectInput = z.object({ repo: REPO_INPUT }).strict()
const connectInput = z
  .object({
    repo: REPO_INPUT,
    branch: BRANCH,
    /** Omitted: public, or private through the GitHub App. deploy_key: a key made with website.github_deploy_key_create. */
    auth: z
      .object({ kind: z.literal('deploy_key'), keyId: KEY_ID })
      .strict()
      .optional(),
  })
  .strict()
const deployKeyCreateInput = z.object({ repo: REPO_INPUT }).strict()
const deployKeyCheckInput = z.object({ repo: REPO_INPUT, keyId: KEY_ID }).strict()
const deployKeyDeleteInput = z.object({ repo: REPO_INPUT, keyId: KEY_ID }).strict()
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

const githubPage = (fullName: string) => `https://github.com/${fullName}`
const removeKeyUrl = (fullName: string) => `${githubPage(fullName)}/settings/keys`

/** ee failures in plain words; the original stays as `cause` for the server log. */
async function viaEe<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof SubstrateUnavailableError)
      throw new GitHubUserError(EE_UNAVAILABLE_MESSAGE, { cause: err })
    if (err instanceof SubstrateError)
      throw new GitHubUserError(
        `The server's deploy agent could not ${what}. Try again; if it keeps happening, ask in the chat.`,
        {
          cause: err,
        },
      )
    throw err
  }
}

export function createGitHubConnectTools(deps: GitHubConnectToolDeps = {}): ToolDescriptor[] {
  const github = deps.github ?? defaultGitHubStore()
  const repos = deps.repos ?? defaultConnectedRepoStore()
  const api = deps.api ?? new GitHubApi()
  const ee: DeployKeyEe = deps.ee ?? new EeClient()

  /** Read-only check through ee: the branches, or the plain reason GitHub refused the key. */
  async function checkKey(
    fullName: string,
    keyId: string,
  ): Promise<{ ok: true; branches: string[] } | { ok: false; message: string }> {
    const r = await viaEe('check the deploy key', () =>
      ee.checkDeployKey(keyId, { repo: fullName }),
    )
    if (r.ok) return { ok: true, branches: r.branches }
    // ssh's own words stay in the server log only.
    console.error(`[website/github] deploy key ${keyId} for ${fullName} not accepted: ${r.detail}`)
    return { ok: false, message: KEY_NOT_ACCEPTED_MESSAGE }
  }

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
          throw new RepoNotVisibleError(
            name,
            auth !== null,
            auth
              ? `GitHub has no public repository ${name}, and the GitHub App cannot see it. If it is private, add it to the app on GitHub (Add more repos on GitHub).`
              : `GitHub has no public repository ${name}. If it is private, connect it with a deploy key.`,
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
    const needsToken = rows.some((r) => r.authKind === 'github_app')
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
        if (r.authKind === 'deploy_key')
          return { ...base, lastCommit: null, lastCommitError: DEPLOY_KEY_LAST_COMMIT }
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
        'Connect a GitHub repository and branch to the company so it can be deployed later. Public repos by link; private repos either through a deploy key (auth {kind: "deploy_key", keyId} from website.github_deploy_key_create, added on GitHub by the owner) or visible to the GitHub App. Does not deploy.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof connectInput>, output?: ConnectedRepo) =>
        `Connected the GitHub repo ${output?.fullName ?? displayName(input.repo)} (${input.branch})`,
      inputSchema: connectInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = connectInput.parse(input)
        let row: Parameters<ConnectedRepoStore['add']>[0]
        if (i.auth?.kind === 'deploy_key') {
          const { owner, repo } = parseOrFail(i.repo)
          const fullName = `${owner}/${repo}`
          const checked = await checkKey(fullName, i.auth.keyId)
          if (!checked.ok) throw new GitHubUserError(checked.message)
          if (!checked.branches.includes(i.branch))
            throw new GitHubUserError(`${fullName} has no branch named “${i.branch}”.`)
          row = {
            repoId: null,
            fullName,
            branch: i.branch,
            htmlUrl: githubPage(fullName),
            cloneUrl: `git@github.com:${fullName}.git`,
            visibility: 'private',
            authKind: 'deploy_key',
            installationId: null,
            deployKeyId: i.auth.keyId,
            connectedBy: principalRef(ctx),
          }
        } else {
          const found = await inspect(i.repo)
          if (!found.branches.includes(i.branch)) {
            throw new GitHubUserError(`${found.fullName} has no branch named “${i.branch}”.`)
          }
          row = {
            repoId: found.repoId,
            fullName: found.fullName,
            branch: i.branch,
            htmlUrl: found.htmlUrl,
            cloneUrl: found.cloneUrl,
            visibility: found.visibility,
            authKind: found.visibility === 'private' ? 'github_app' : 'public',
            installationId: found.installationId,
            deployKeyId: null,
            connectedBy: principalRef(ctx),
          }
        }
        try {
          return await repos.add(row)
        } catch (err) {
          if (err instanceof RepoAlreadyConnectedError) {
            throw new GitHubUserError(`${row.fullName} (${i.branch}) is already connected.`, {
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
      summary:
        'Disconnect a GitHub repository branch from the company. For a deploy-key repo this deletes its key on the server only when no connected branch still uses it (human only, D11); the owner can then remove it on GitHub too (removeKeyUrl). Nothing on GitHub changes.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: (input: z.infer<typeof disconnectInput>) =>
        `Disconnected the GitHub repo ${displayName(input.repo)} (${input.branch})`,
      inputSchema: disconnectInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = disconnectInput.parse(input)
        const { owner, repo } = parseOrFail(i.repo)
        const fullName = `${owner}/${repo}`
        const connected = await repos.list()
        const match = connected.find(
          (r) => r.fullName.toLowerCase() === fullName.toLowerCase() && r.branch === i.branch,
        )
        if (!match) throw new GitHubUserError(`${fullName} (${i.branch}) is not connected.`)
        let keyDeleted = false
        if (match.authKind === 'deploy_key' && match.deployKeyId) {
          const author = requireHuman(ctx, 'website.github_disconnect_repo')
          const keyId = match.deployKeyId
          const shared = connected.some((r) => r !== match && r.deployKeyId === keyId)
          if (!shared) {
            await viaEe('delete the deploy key', () => ee.deleteDeployKey(keyId, { author }))
            keyDeleted = true
          }
        }
        const removed = await repos.remove(match.fullName, match.branch)
        if (!removed) throw new GitHubUserError(`${fullName} (${i.branch}) is not connected.`)
        return {
          ...removed,
          createdAt: removed.createdAt.toISOString(),
          removeKeyUrl: keyDeleted ? removeKeyUrl(removed.fullName) : null,
        }
      },
    },
    {
      name: 'website.github_deploy_key_create',
      module: WEBSITE_MODULE_ID,
      summary:
        "Create a read-only deploy key for one private GitHub repo. The server (ee) generates and keeps the key; this returns only the public key and the GitHub page where the owner adds it (Settings → Deploy keys, write access off). Human only: it changes the server's secret store (D11).",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof deployKeyCreateInput>) =>
        `Created a deploy key for ${displayName(input.repo)}`,
      inputSchema: deployKeyCreateInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'website.github_deploy_key_create')
        const { owner, repo } = parseOrFail(deployKeyCreateInput.parse(input).repo)
        const fullName = `${owner}/${repo}`
        const key = await viaEe('create a deploy key', () =>
          ee.createDeployKey({ repo: fullName, author }),
        )
        return {
          repo: fullName,
          keyId: key.keyId,
          publicKey: key.publicKey,
          addKeyUrl: `${githubPage(fullName)}/settings/keys/new`,
        }
      },
    },
    {
      name: 'website.github_deploy_key_check',
      module: WEBSITE_MODULE_ID,
      summary:
        'Check whether GitHub accepts a deploy key for its repo (a read-only git ls-remote on the server) and list the branches. Returns {ok: true, branches} or {ok: false, message} in plain words.',
      auditClass: 'read',
      inputSchema: deployKeyCheckInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const i = deployKeyCheckInput.parse(input)
        const { owner, repo } = parseOrFail(i.repo)
        return checkKey(`${owner}/${repo}`, i.keyId)
      },
    },
    {
      name: 'website.github_deploy_key_delete',
      module: WEBSITE_MODULE_ID,
      summary:
        'Delete a deploy key the server holds that no connected repo uses (to disconnect a repo, use website.github_disconnect_repo). Human only (D11). The key should then also be removed on GitHub (removeKeyUrl).',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: (input: z.infer<typeof deployKeyDeleteInput>) =>
        `Deleted the deploy key for ${displayName(input.repo)}`,
      inputSchema: deployKeyDeleteInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'website.github_deploy_key_delete')
        const i = deployKeyDeleteInput.parse(input)
        const { owner, repo } = parseOrFail(i.repo)
        const user = (await repos.list()).find((r) => r.deployKeyId === i.keyId)
        if (user)
          throw new GitHubUserError(
            `${user.fullName} (${user.branch}) uses this key. Disconnect it instead.`,
          )
        await viaEe('delete the deploy key', () => ee.deleteDeployKey(i.keyId, { author }))
        return { ok: true as const, removeKeyUrl: removeKeyUrl(`${owner}/${repo}`) }
      },
    },
  ]
}
