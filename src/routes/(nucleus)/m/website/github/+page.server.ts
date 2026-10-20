import type {
  ConnectedRepoView,
  GitHubConnectStatus,
  InspectedRepo,
} from '../../../../../../modules/website/github/connect-tools'
import type { Actions, PageServerLoad } from './$types'
import { randomBytes, randomUUID } from 'node:crypto'
import { fail } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { decideApprovalAsOwner } from '$lib/server/approvals/owner-decision'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { bootstrapKernel, ensureSystemModulesActive } from '../../../../../../modules/index'
import { plainMessage } from '../../../../../../modules/website/github/plain-errors'
import { parseGitHubRepo } from '../../../../../../modules/website/github/repo-url'
import { GITHUB_STATE_COOKIE, githubAppManifest } from '../../../../settings/hosting/manifest'

/**
 * /m/website/github: connect GitHub (App manifest flow), then connect repos —
 * public ones by link, private ones the installed App can see. Every read and
 * change runs through the kernel registry as the signed-in owner, so it is
 * permission-checked and audited. The owner's click IS their decision: when
 * the approval mode gates a connect/disconnect, the click approves it.
 * Errors reach the page as plain sentences, never raw GitHub API errors.
 *
 * Private repos default to a read-only deploy key (owner's decision, 2026-10-20:
 * no whole-account GitHub App by default). The server's ee makes and keeps the
 * key; the page only carries the PUBLIC key and ee's key id between steps.
 */

export type AvailableRepo = {
  repoId: number
  fullName: string
  visibility: 'public' | 'private'
  defaultBranch: string
}

function ownerCtx(user: { id: string }): ToolContext {
  return { principal: { id: user.id, kind: 'human', roles: ['admin'] }, requestId: randomUUID() }
}

async function kernel() {
  const k = bootstrapKernel()
  await ensureSystemModulesActive(k)
  return k
}

async function run<T>(user: { id: string }, tool: string, input: unknown): Promise<T> {
  const k = await kernel()
  try {
    return (await k.registry.execute(tool, input, ownerCtx(user))) as T
  } catch (err) {
    const approvalId =
      err instanceof KernelError && err.code === 'approval_required'
        ? err.details?.approvalId
        : undefined
    if (typeof approvalId !== 'string') throw err
    // The owner clicked the button themselves: record that as their approval, then run it.
    await decideApprovalAsOwner(k.registry, user, approvalId, 'approved')
    return (await k.registry.execute(tool, input, ownerCtx(user))) as T
  }
}

function logFailure(tool: string, err: unknown): void {
  // Server log only (the page shows plain words). No credentials are ever in these errors.
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
  console.error(
    `[website/github] ${tool} failed: ${err instanceof Error ? err.message : String(err)}${cause}`,
  )
}

export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const listed = await run<{ github: GitHubConnectStatus; repos: ConnectedRepoView[] }>(
    user,
    'website.github_list_repos',
    {},
  )

  let available: AvailableRepo[] | null = null
  let availableError: string | null = null
  if (listed.github.installed) {
    try {
      available = await run<AvailableRepo[]>(user, 'website.github_available_repos', {})
    } catch (err) {
      logFailure('website.github_available_repos', err)
      availableError = plainMessage(err)
    }
  }

  let manifest: { json: string; state: string } | null = null
  if (!listed.github.connected) {
    const state = randomBytes(16).toString('hex')
    event.cookies.set(GITHUB_STATE_COOKIE, state, {
      path: '/settings/hosting/github',
      httpOnly: true,
      sameSite: 'lax',
      secure: event.url.protocol === 'https:',
      maxAge: 60 * 30,
    })
    manifest = {
      json: JSON.stringify(githubAppManifest(event.url.origin, randomBytes(2).toString('hex'))),
      state,
    }
  }

  return { github: listed.github, repos: listed.repos, available, availableError, manifest }
}

const field = (f: FormData, name: string) => String(f.get(name) ?? '').trim()

type DeployKeyPending = { repo: string; keyId: string; publicKey: string; addKeyUrl: string }

function pendingKey(f: FormData): DeployKeyPending {
  const repo = field(f, 'repo')
  return {
    repo,
    keyId: field(f, 'keyId'),
    publicKey: field(f, 'publicKey'),
    addKeyUrl: `https://github.com/${repo}/settings/keys/new`,
  }
}

const keysPage = (repo: string) => ({
  href: `https://github.com/${repo}/settings/keys`,
  label: `Deploy keys of ${repo} on GitHub`,
})

export const actions: Actions = {
  /** Check a repo (public link, or a private one picked from the list) and offer its branches. */
  inspect: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const repo = field(await event.request.formData(), 'repo')
    try {
      const inspected = await run<InspectedRepo>(user, 'website.github_inspect_repo', { repo })
      const parsed = parseGitHubRepo(repo)
      const linked = parsed.ok ? parsed.branch : null
      const branch =
        linked && inspected.branches.includes(linked) ? linked : inspected.defaultBranch
      return { action: 'inspect' as const, repo, inspected, branch }
    } catch (err) {
      logFailure('website.github_inspect_repo', err)
      return fail(400, { action: 'inspect' as const, repo, error: plainMessage(err) })
    }
  },
  connect: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const repo = field(f, 'repo')
    const branch = field(f, 'branch')
    try {
      await run(user, 'website.github_connect_repo', { repo, branch })
      return { action: 'connect' as const, ok: true, message: `Connected ${repo} (${branch}).` }
    } catch (err) {
      logFailure('website.github_connect_repo', err)
      return fail(400, { action: 'connect' as const, repo, error: plainMessage(err) })
    }
  },
  disconnect: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const repo = field(f, 'repo')
    const branch = field(f, 'branch')
    try {
      const removed = await run<{ fullName: string; removeKeyUrl: string | null }>(
        user,
        'website.github_disconnect_repo',
        { repo, branch },
      )
      if (removed.removeKeyUrl) {
        return {
          action: 'disconnect' as const,
          ok: true,
          message: `Disconnected ${repo} (${branch}) and deleted its deploy key on this server. You can remove the key on GitHub too.`,
          link: keysPage(removed.fullName),
        }
      }
      return {
        action: 'disconnect' as const,
        ok: true,
        message: `Disconnected ${repo} (${branch}).`,
      }
    } catch (err) {
      logFailure('website.github_disconnect_repo', err)
      return fail(400, { action: 'disconnect' as const, repo, error: plainMessage(err) })
    }
  },
  /** Step 1: ee makes a key pair for the repo; the page shows the public key and where to add it. */
  deployKeyCreate: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const repo = field(await event.request.formData(), 'repo')
    try {
      const key = await run<DeployKeyPending>(user, 'website.github_deploy_key_create', { repo })
      return { action: 'deploy_key' as const, step: 'add' as const, ...key }
    } catch (err) {
      logFailure('website.github_deploy_key_create', err)
      return fail(400, {
        action: 'deploy_key' as const,
        step: 'repo' as const,
        repo,
        error: plainMessage(err),
      })
    }
  },
  /** Step 2: a read-only check that GitHub accepts the key; lists the branches. */
  deployKeyCheck: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const pending = pendingKey(await event.request.formData())
    try {
      const checked = await run<{ ok: true; branches: string[] } | { ok: false; message: string }>(
        user,
        'website.github_deploy_key_check',
        { repo: pending.repo, keyId: pending.keyId },
      )
      if (!checked.ok) {
        return fail(400, {
          action: 'deploy_key' as const,
          step: 'add' as const,
          ...pending,
          error: checked.message,
        })
      }
      // Preselect only; the owner picks the branch.
      const branch = checked.branches.includes('main') ? 'main' : (checked.branches[0] ?? '')
      return {
        action: 'deploy_key' as const,
        step: 'branches' as const,
        ...pending,
        branches: checked.branches,
        branch,
      }
    } catch (err) {
      logFailure('website.github_deploy_key_check', err)
      return fail(400, {
        action: 'deploy_key' as const,
        step: 'add' as const,
        ...pending,
        error: plainMessage(err),
      })
    }
  },
  /** Step 3: connect the picked branch, reading through the deploy key. */
  deployKeyConnect: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const pending = pendingKey(f)
    const branch = field(f, 'branch')
    try {
      await run(user, 'website.github_connect_repo', {
        repo: pending.repo,
        branch,
        auth: { kind: 'deploy_key', keyId: pending.keyId },
      })
      return {
        action: 'connect' as const,
        ok: true,
        message: `Connected ${pending.repo} (${branch}).`,
      }
    } catch (err) {
      logFailure('website.github_connect_repo', err)
      return fail(400, {
        action: 'deploy_key' as const,
        step: 'add' as const,
        ...pending,
        error: plainMessage(err),
      })
    }
  },
  /** Give up before connecting: the unused key is deleted on the server. */
  deployKeyCancel: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const pending = pendingKey(await event.request.formData())
    try {
      await run(user, 'website.github_deploy_key_delete', {
        repo: pending.repo,
        keyId: pending.keyId,
      })
      return {
        action: 'deploy_key_cancel' as const,
        ok: true,
        message: `Deleted the unused deploy key for ${pending.repo} on this server. If you already added it on GitHub, you can remove it there too.`,
        link: keysPage(pending.repo),
      }
    } catch (err) {
      logFailure('website.github_deploy_key_delete', err)
      return fail(400, {
        action: 'deploy_key' as const,
        step: 'add' as const,
        ...pending,
        error: plainMessage(err),
      })
    }
  },
}
