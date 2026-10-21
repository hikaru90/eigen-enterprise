import type { ServiceView } from '../../../../../../../modules/website/apps/tools'
import type {
  ConnectedRepoView,
  GitHubConnectStatus,
  InspectedRepo,
} from '../../../../../../../modules/website/github/connect-tools'
import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import type { Catalog } from '$lib/server/ee/client'
import { settleBriefly, startOwnerDeploy } from '$lib/server/website/deploy-runner'
import { logAppFailure, ownerRun, plainAppMessage } from '$lib/server/website/owner-run'
import { contractFormSchema } from '../../../../../../../modules/website/apps/contract'
import { appSlug } from '../../../../../../../modules/website/apps/host'
import { plainMessage } from '../../../../../../../modules/website/github/plain-errors'
import { parseGitHubRepo } from '../../../../../../../modules/website/github/repo-url'
import { formContract } from '../form'

const SETTLE_MS = 1500

/**
 * /m/website/apps/new: adding an app from a repo (decision D-W4). Connecting
 * the repo — inspect, a deploy key only when the repo is private — is a step
 * of the flow; the Deploy click at the end is the same the Apps overview had.
 * The owner's click is their approval (ownerRun); GitHub errors reach the
 * page as plain sentences, never raw API errors.
 */

/** A connected repo as the stepper shows it. */
export type RepoRow = {
  fullName: string
  branch: string
  htmlUrl: string
  visibility: 'public' | 'private'
  authKind: 'public' | 'github_app' | 'deploy_key'
  /** A service already deploys this repo + branch (so it may not be disconnected here). */
  used: boolean
  usedBy: string | null
  /** A free app name derived from the repo (free of the names in takenNames). */
  suggestedName: string
}

/** A repo the installed GitHub App can see, not connected yet. */
export type AvailableRepoRow = {
  repoId: number
  fullName: string
  visibility: 'public' | 'private'
  defaultBranch: string
}

type SubstrateStatus =
  { managed: true; settings: { consoleHost: string } } | { managed: false; reason: string }

/** First free variant of base ("shop" → "shop-2" → …) that fits the app-name shape. */
function freeName(taken: ReadonlySet<string>, base: string): string {
  let name = base
  for (let i = 2; taken.has(name); i++) {
    const suffix = `-${i}`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  return name
}

export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const listed = await ownerRun<{ github: GitHubConnectStatus; repos: ConnectedRepoView[] }>(
    user,
    'website.github_list_repos',
    {},
  )
  let services: ServiceView[] = []
  let catalog: Catalog | null = null
  let appsError: string | null = null
  try {
    // When ee is unreachable app_list does not throw: it returns the services from
    // the database with `catalog: null`; the not-managed state is read below.
    const out = await ownerRun<{ services: ServiceView[]; catalog: Catalog | null }>(
      user,
      'website.app_list',
      {},
    )
    services = out.services
    catalog = out.catalog
  } catch (err) {
    logAppFailure('website.app_list', err)
    appsError = plainAppMessage(err)
  }
  // ee unreachable is the explicit not-managed state (never a fallback): the
  // page keeps working for repo connecting and says plainly why deploy is off.
  const status = await ownerRun<SubstrateStatus>(user, 'substrate.status', {})

  let available: AvailableRepoRow[] | null = null
  let availableError: string | null = null
  if (listed.github.installed) {
    try {
      available = await ownerRun<AvailableRepoRow[]>(user, 'website.github_available_repos', {})
    } catch (err) {
      logAppFailure('website.github_available_repos', err)
      availableError = plainMessage(err)
    }
  }

  const taken = new Set(services.map((s) => s.name.toLowerCase()))
  const serviceOf = (r: ConnectedRepoView) =>
    services.find((s) => s.repo.toLowerCase() === r.fullName.toLowerCase() && s.branch === r.branch)
  return {
    github: listed.github,
    repos: listed.repos.map((r) => {
      const usedBy = serviceOf(r)
      return {
        fullName: r.fullName,
        branch: r.branch,
        htmlUrl: r.htmlUrl,
        visibility: r.visibility,
        authKind: r.authKind,
        used: usedBy !== undefined,
        usedBy: usedBy?.name ?? null,
        suggestedName: freeName(taken, appSlug(r.fullName.split('/')[1] ?? r.fullName)),
      }
    }),
    available,
    availableError,
    takenNames: services.map((s) => s.name),
    catalog,
    appsError,
    managed: status.managed,
    consoleHost: status.managed ? status.settings.consoleHost : null,
    managedReason: status.managed ? null : status.reason,
  }
}

const field = (f: FormData, name: string) => String(f.get(name) ?? '').trim()
const optional = (v: string) => (v === '' ? undefined : v)

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
  /** Read a repo (link or owner/name) as GitHub sees it: visibility decides the next step. */
  inspect: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const repo = field(await event.request.formData(), 'repo')
    try {
      const inspected = await ownerRun<InspectedRepo>(user, 'website.github_inspect_repo', { repo })
      const parsed = parseGitHubRepo(repo)
      const linked = parsed.ok ? parsed.branch : null
      const branch =
        linked && inspected.branches.includes(linked) ? linked : inspected.defaultBranch
      return { action: 'inspect' as const, repo, inspected, branch }
    } catch (err) {
      logAppFailure('website.github_inspect_repo', err)
      return fail(400, { action: 'inspect' as const, repo, error: plainMessage(err) })
    }
  },

  /** Step 1 of the private flow: ee makes a read-only key; the page only carries its public half. */
  deployKeyCreate: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const repo = field(await event.request.formData(), 'repo')
    try {
      const key = await ownerRun<DeployKeyPending>(user, 'website.github_deploy_key_create', {
        repo,
      })
      return { action: 'deploy_key' as const, ...key }
    } catch (err) {
      logAppFailure('website.github_deploy_key_create', err)
      return fail(400, { action: 'deploy_key' as const, repo, error: plainMessage(err) })
    }
  },

  /** Step 2: a read-only check that GitHub accepts the key; the answer lists the branches. */
  deployKeyCheck: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const pending = pendingKey(await event.request.formData())
    try {
      const checked = await ownerRun<
        { ok: true; branches: string[] } | { ok: false; message: string }
      >(user, 'website.github_deploy_key_check', { repo: pending.repo, keyId: pending.keyId })
      if (!checked.ok) {
        return fail(400, { action: 'deploy_key' as const, ...pending, error: checked.message })
      }
      // Preselect only; the owner picks the branch.
      const branch = checked.branches.includes('main') ? 'main' : (checked.branches[0] ?? '')
      return { action: 'deploy_key' as const, ...pending, branches: checked.branches, branch }
    } catch (err) {
      logAppFailure('website.github_deploy_key_check', err)
      return fail(400, { action: 'deploy_key' as const, ...pending, error: plainMessage(err) })
    }
  },

  /** Giving up before connecting: the unused key is deleted on the server. */
  deployKeyCancel: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const pending = pendingKey(await event.request.formData())
    try {
      await ownerRun(user, 'website.github_deploy_key_delete', {
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
      logAppFailure('website.github_deploy_key_delete', err)
      return fail(400, { action: 'deploy_key' as const, ...pending, error: plainMessage(err) })
    }
  },

  /** Record the repo + branch so it can be deployed (public by link, private via App or key). */
  connect: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const repo = field(f, 'repo')
    const branch = field(f, 'branch')
    const keyId = field(f, 'keyId')
    try {
      await ownerRun(user, 'website.github_connect_repo', {
        repo,
        branch,
        ...(keyId ? { auth: { kind: 'deploy_key' as const, keyId } } : {}),
      })
      return { action: 'connect' as const, ok: true, message: `Connected ${repo} (${branch}).` }
    } catch (err) {
      logAppFailure('website.github_connect_repo', err)
      return fail(400, { action: 'connect' as const, repo, error: plainMessage(err) })
    }
  },

  /** Only offered for repos no service uses; the tool refuses an unknown pair in plain words. */
  disconnect: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const repo = field(f, 'repo')
    const branch = field(f, 'branch')
    try {
      const removed = await ownerRun<{ removeKeyUrl: string | null }>(
        user,
        'website.github_disconnect_repo',
        { repo, branch },
      )
      return removed.removeKeyUrl
        ? {
            action: 'disconnect' as const,
            ok: true,
            message: `Disconnected ${repo} (${branch}) and deleted its deploy key on this server. You can remove the key on GitHub too.`,
            link: keysPage(repo),
          }
        : { action: 'disconnect' as const, ok: true, message: `Disconnected ${repo} (${branch}).` }
    } catch (err) {
      logAppFailure('website.github_disconnect_repo', err)
      return fail(400, { action: 'disconnect' as const, repo, error: plainMessage(err) })
    }
  },

  /** The old overview's deploy: validate, start in the background, redirect when it settles fast. */
  deploy: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const repo = field(f, 'repo')
    const branch = field(f, 'branch')
    const name = field(f, 'name')
    const contract = formContract(f)
    if (contract) {
      const checked = contractFormSchema.safeParse(contract)
      if (!checked.success) {
        return fail(400, {
          action: 'deploy' as const,
          name,
          error: checked.error.issues[0]?.message ?? 'Check the build form.',
        })
      }
    }
    const input = {
      name,
      repo,
      branch,
      kind: field(f, 'kind') === 'backend' ? 'backend' : 'web',
      ...(contract ? { contract } : {}),
      ...(optional(field(f, 'host')) ? { host: field(f, 'host') } : {}),
      ...(field(f, 'autoDeploy') === 'on' ? { autoDeploy: true } : {}),
    }
    // In the background: the page follows the job (stage + log) instead of one long request.
    const job = startOwnerDeploy(user, input)
    await settleBriefly(job, SETTLE_MS)
    if (job.state === 'failed') {
      // An instant refusal (form, repo, name) goes straight back to the form; the page
      // still follows the job, so a recorded attempt shows its log and "Ask AI".
      return fail(400, { action: 'deploy' as const, name, error: job.error ?? '', jobId: job.id })
    }
    if (job.state === 'done') redirect(303, `/m/website/apps/${name}`)
    return { action: 'deploy' as const, name, jobId: job.id }
  },
}
