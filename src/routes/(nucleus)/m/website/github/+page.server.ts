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
      await run(user, 'website.github_disconnect_repo', { repo, branch })
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
}
