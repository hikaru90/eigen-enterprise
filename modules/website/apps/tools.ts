import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import {
  EeClient,
  SubstrateError,
  SubstrateUnavailableError,
  type AppContract,
  type EeStatus,
} from '$lib/server/ee/client'
import { requireHuman } from '$lib/server/ee/human'
import { GitHubApi } from '../github/api'
import {
  defaultConnectedRepoStore,
  type ConnectedRepo,
  type ConnectedRepoStore,
} from '../github/repos-store'
import { defaultGitHubStore } from '../github/store'
import { WEBSITE_MODULE_ID } from '../manifest'
import { AppUserError, contractFormSchema, gapError, resolveContract } from './contract'
import { fetchInputFor, mirrorName } from './fetch-auth'
import { appHost } from './host'
import { defaultServiceStore, type Service, type ServiceKind, type ServiceStore } from './store'

/**
 * Website → Apps (plan/phase-platform.md step 3): a connected repo + branch
 * becomes a service (web app or back-end service) that ee builds sandboxed,
 * health-gates, switches blue-green and routes.
 *
 * Who may change the server (D11 as amended by the owner, 2026-10-20):
 * - the owner's own click on the page is a human action;
 * - the agent may deploy and set env, but ONLY through the approval gate: those
 *   tools are on APPROVAL_REQUIRED_TOOLS (modules/index.ts; a test holds the two
 *   lists together), so under "ask" every agent deploy waits for the owner and
 *   the mode decides the rest;
 * - removing an app stays human-only (requireHuman);
 * - push-to-deploy runs as the webhook's service principal, only for services
 *   whose owner switched auto-deploy on (that switch is the standing approval).
 */

/** ee's verbs this module uses; a seam so tests fake ee without a socket. */
export type AppsEe = Pick<
  EeClient,
  | 'status'
  | 'catalog'
  | 'fetchSource'
  | 'sourceContract'
  | 'createApp'
  | 'addDomain'
  | 'setSecret'
  | 'events'
  | 'logs'
  | 'removeApp'
>

export type AppToolDeps = {
  ee?: AppsEe
  repos?: ConnectedRepoStore
  services?: ServiceStore
  /** A fresh GitHub App installation token (never stored). */
  mintToken?: (installationId: number) => Promise<string>
  now?: () => Date
}

/** Agent-callable tools that change the server: each MUST be approval-gated. */
export const APP_AGENT_GATED_TOOLS = ['website.app_deploy', 'website.app_env_set'] as const

export const EE_UNAVAILABLE_APPS =
  "Deploying needs the server's deploy agent (ee). This copy of Eigen Enterprise isn't running on a server set up with ee."

/** Variables ee sets itself; an env editor may not shadow them. */
const RESERVED_ENV = [
  'PORT',
  'HOST',
  'NODE_ENV',
  'EE_WORKLOAD',
  'EE_STATE_DIR',
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
]

const NAME = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'app name: lowercase letters, digits, dashes (2–31)')
const REPO = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repository as owner/name')
const BRANCH = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/, 'a branch name')
const HOST = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
    'a host name like shop.example.com',
  )
const ENV_KEY = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'a variable name in CAPITALS, like API_KEY')

const deployInput = z
  .object({
    name: NAME,
    /** New service: the connected repo + branch it builds from. Redeploys omit them. */
    repo: REPO.optional(),
    branch: BRANCH.optional(),
    kind: z.enum(['web', 'backend']).optional(),
    /** How to build and start it, when the repo has no ee.json. */
    contract: contractFormSchema.optional(),
    /** Web apps on the owner's own domain; otherwise derived from this server's host. */
    host: HOST.optional(),
    /** Push-to-deploy (GitHub App repos only). */
    autoDeploy: z.boolean().optional(),
  })
  .strict()
const nameInput = z.object({ name: NAME }).strict()
const envSetInput = z
  .object({ name: NAME, key: ENV_KEY, value: z.string().min(1).max(16384) })
  .strict()
const autoDeployInput = z
  .object({
    repoId: z.number().int().positive(),
    repo: REPO,
    ref: BRANCH,
    after: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict()

export type ServiceStatus = 'healthy' | 'deploying' | 'failed'

export type ServiceView = {
  name: string
  kind: ServiceKind
  repo: string
  branch: string
  authKind: Service['authKind']
  status: ServiceStatus
  url: string | null
  shortSha: string | null
  lastDeployedAt: string | null
  lastError: string | null
  autoDeploy: boolean
}

export type DeployResult = {
  name: string
  repo: string
  branch: string
  kind: ServiceKind
  commit: string
  url: string | null
  state: 'healthy'
  contractSource: 'repo' | 'form'
}

/** Human, or the agent past the approval gate (APP_AGENT_GATED_TOOLS). Never a service. */
function deployer(ctx: ToolContext, tool: string): string {
  if (ctx.principal.kind === 'human') return `human:${ctx.principal.id}`
  if (ctx.principal.kind === 'agent') return `agent:${ctx.principal.id}`
  throw new KernelError(
    'permission_denied',
    `${tool} is run by the owner, or by the agent with the owner's approval`,
  )
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const urlFor = (s: Pick<Service, 'kind' | 'host'>) =>
  s.kind === 'web' && s.host ? `https://${s.host}` : null

/** ee failures in plain words; the original stays in the server log and as `cause`. */
async function viaEe<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof AppUserError) throw err
    if (err instanceof SubstrateUnavailableError)
      throw new AppUserError(EE_UNAVAILABLE_APPS, { cause: err })
    if (err instanceof SubstrateError) {
      console.error(`[website/apps] ee could not ${what}: ${err.status} ${err.message}`)
      throw new AppUserError(
        `The server's deploy agent could not ${what}. Try again; if it keeps happening, ask in the chat.`,
        {
          cause: err,
        },
      )
    }
    throw err
  }
}

function statusOf(s: Service, w: EeStatus['workloads'][number] | undefined): ServiceStatus {
  if (s.state === 'deploying') return 'deploying'
  if (w?.live && !w.lastError && s.state !== 'failed') return 'healthy'
  return 'failed'
}

export function createAppTools(deps: AppToolDeps = {}): ToolDescriptor[] {
  const ee: AppsEe = deps.ee ?? new EeClient()
  const repos = deps.repos ?? defaultConnectedRepoStore()
  const services = deps.services ?? defaultServiceStore()
  const now = deps.now ?? (() => new Date())
  const mintToken =
    deps.mintToken ??
    (async (installationId: number) => {
      const github = defaultGitHubStore()
      const conn = await github.connection()
      if (!conn)
        throw new AppUserError(
          'GitHub is not connected any more — reconnect it under Website → GitHub.',
        )
      const creds = await github.credentials()
      return new GitHubApi().installationToken(conn.appId, creds.privateKeyPem, installationId)
    })

  async function connectedRepo(fullName: string, branch: string): Promise<ConnectedRepo> {
    const found = (await repos.list()).find(
      (r) => sameName(r.fullName, fullName) && r.branch === branch,
    )
    if (!found)
      throw new AppUserError(
        `Connect ${fullName} (${branch}) first under Website → GitHub, then deploy it.`,
      )
    return found
  }

  /** Fetch → contract → app → route → health. Records the outcome on the service row. */
  async function deploy(i: z.infer<typeof deployInput>, author: string): Promise<DeployResult> {
    const existing = await services.get(i.name)
    if (!existing && (!i.repo || !i.branch || !i.kind)) {
      throw new AppUserError(
        `There is no app called ${i.name} yet. To deploy a new one, give its repo, branch and kind (web app or back-end service).`,
      )
    }
    if (
      existing &&
      ((i.repo && !sameName(i.repo, existing.repoFullName)) ||
        (i.branch && i.branch !== existing.branch))
    ) {
      throw new AppUserError(
        `${i.name} deploys ${existing.repoFullName} (${existing.branch}). To deploy another repo or branch, give it a new name.`,
      )
    }
    const repoName = existing?.repoFullName ?? i.repo!
    const branch = existing?.branch ?? i.branch!
    const kind = i.kind ?? existing!.kind
    const repo = await connectedRepo(repoName, branch)
    const autoDeploy = i.autoDeploy ?? existing?.autoDeploy ?? false
    if (autoDeploy && (repo.authKind !== 'github_app' || repo.repoId === null)) {
      throw new AppUserError(
        'Push-to-deploy needs the repo connected through the GitHub App. Repos read with a deploy key or by public link are deployed by hand (Deploy now).',
      )
    }

    const status = await viaEe('read the server status', () => ee.status())
    const workload = status.workloads.find((w) => w.name === i.name)
    if (workload && !existing)
      throw new AppUserError(`An app named ${i.name} already runs here. Pick another name.`)

    let host: string | null = null
    if (kind === 'web') {
      host = i.host ?? existing?.host ?? appHost(status.settings.consoleHost, i.name)
      if (!host) {
        throw new AppUserError(
          `This server has no automatic address for apps. Give ${i.name} a domain (for example ${i.name}.yourdomain.com) and point its DNS at this server.`,
        )
      }
    }

    const fetch = await fetchInputFor(repo, i.name, mintToken)
    const fetched = await viaEe(`fetch ${repo.fullName} (${branch}) from GitHub`, () =>
      ee.fetchSource(fetch),
    )
    const [repoContract, catalog] = await Promise.all([
      viaEe("read the repo's ee.json", () =>
        ee.sourceContract({ name: mirrorName(i.name), rev: fetched.rev }),
      ),
      viaEe('read the catalog', () => ee.catalog()),
    ])
    const resolved = resolveContract({
      repo: repoContract,
      form: i.contract ?? null,
      stored: workload?.contract ?? null,
      catalog,
    })

    await services.upsert({
      name: i.name,
      kind,
      repoFullName: repo.fullName,
      branch,
      repoId: repo.repoId,
      authKind: repo.authKind,
      host,
      autoDeploy,
      createdBy: author,
    })
    await services.markDeploying(i.name)

    const record = (state: 'healthy' | 'failed', error: string | null) =>
      services.recordDeploy(i.name, { state, rev: fetched.rev, error, by: author, at: now() })
    try {
      await ee.createApp({
        name: i.name,
        source: { kind: 'git', mirror: fetched.mirror, ref: branch, rev: fetched.rev },
        env: {},
        secrets: workload?.declaredSecrets ?? [],
        deploy: { auto: false },
        ...(resolved.source === 'form' ? { contract: resolved.contract } : {}),
        author,
      })
      if (host && !status.routes.some((r) => r.host === host)) {
        await ee.addDomain({ host, workload: i.name, role: 'app', author })
      }
    } catch (err) {
      const plain =
        err instanceof SubstrateError && err.type === 'urn:ee:catalog_gap'
          ? gapError((err.body as { missing?: string[] } | null)?.missing ?? [], catalog)
          : null
      if (plain) {
        await record('failed', plain.message)
        throw plain
      }
      await record('failed', 'The server could not apply this deploy.')
      return viaEe(`deploy ${i.name}`, () => Promise.reject(err))
    }

    const after = await viaEe('read the server status', () => ee.status())
    const live = after.workloads.find((w) => w.name === i.name)
    const isNew =
      live?.live?.release === 'static' || live?.live?.release.startsWith(fetched.rev.slice(0, 16))
    if (live && isNew && !live.lastError) {
      await record('healthy', null)
      return {
        name: i.name,
        repo: repo.fullName,
        branch,
        kind,
        commit: fetched.rev,
        url: urlFor({ kind, host }),
        state: 'healthy',
        contractSource: resolved.source,
      }
    }
    const message = await failureMessage(i.name, resolved.contract, live?.live != null)
    console.error(
      `[website/apps] deploy of ${i.name} @ ${fetched.rev.slice(0, 12)} failed: ${live?.lastError ?? 'no live release'}`,
    )
    await record('failed', message)
    throw new AppUserError(message)
  }

  /** Plain words from the journal's structured event type (never from parsing its text). */
  async function failureMessage(
    name: string,
    contract: AppContract,
    previousServes: boolean,
  ): Promise<string> {
    const { events } = await viaEe('read the deploy history', () => ee.events(name))
    const last = [...events]
      .reverse()
      .find((e) => e.type === 'deploy.failed' || e.type === 'workload.error')
    const keeps = previousServes ? ' The previous version keeps serving.' : ''
    if (last?.type === 'deploy.failed') {
      return `${name} built, but didn't answer GET ${contract.health} in time, so it was stopped.${keeps} Its logs show why.`
    }
    return `${name} could not be built or started.${keeps} The deploy history has the server's details.`
  }

  async function views(): Promise<{ services: ServiceView[]; status: EeStatus }> {
    const [rows, status] = await Promise.all([
      services.list(),
      viaEe('read the server status', () => ee.status()),
    ])
    return {
      status,
      services: rows.map((s) => {
        const w = status.workloads.find((x) => x.name === s.name)
        return {
          name: s.name,
          kind: s.kind,
          repo: s.repoFullName,
          branch: s.branch,
          authKind: s.authKind,
          status: statusOf(s, w),
          url: urlFor(s),
          shortSha: s.lastRev ? s.lastRev.slice(0, 7) : null,
          lastDeployedAt: s.lastDeployedAt ? s.lastDeployedAt.toISOString() : null,
          lastError: s.lastError,
          autoDeploy: s.autoDeploy,
        }
      }),
    }
  }

  async function mustService(name: string): Promise<Service> {
    const s = await services.get(name)
    if (!s) throw new AppUserError(`There is no app called ${name}.`)
    return s
  }

  return [
    {
      name: 'website.app_list',
      module: WEBSITE_MODULE_ID,
      summary:
        'Apps and services deployed from connected GitHub repos: status (healthy, deploying, failed), URL, branch@commit, last deploy.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => ({
        services: (await views()).services,
        // What a build form can pick from (D16: nothing outside the catalog).
        catalog: await viaEe('read the catalog', () => ee.catalog()),
      }),
    },
    {
      name: 'website.app_get',
      module: WEBSITE_MODULE_ID,
      summary:
        "One app's detail: status, deploy history, domains, env variable NAMES (values are never shown), and where its build contract comes from.",
      auditClass: 'read',
      inputSchema: nameInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const { name } = nameInput.parse(input)
        await mustService(name)
        const { services: all, status } = await views()
        const view = all.find((s) => s.name === name)!
        const w = status.workloads.find((x) => x.name === name)
        const { events } = await viaEe('read the deploy history', () => ee.events(name))
        return {
          ...view,
          env: w?.secrets ?? [],
          domains: status.routes.filter((r) => r.workload === name).map((r) => r.host),
          contractSource: w?.contract ? 'form' : 'repo',
          contract: w?.contract ?? null,
          history: events
            .filter(
              (e) =>
                e.type.startsWith('deploy.') ||
                e.type === 'workload.error' ||
                e.type === 'secret.set',
            )
            .reverse()
            .map((e) => ({ time: e.time, type: e.type, message: e.message })),
        }
      },
    },
    {
      name: 'website.app_logs',
      module: WEBSITE_MODULE_ID,
      summary: "Recent log lines of an app's live version (plain text).",
      auditClass: 'read',
      inputSchema: nameInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const { name } = nameInput.parse(input)
        await mustService(name)
        try {
          const out = await ee.logs(name)
          return { name, lines: out.lines }
        } catch (err) {
          if (err instanceof SubstrateError && err.status === 404) {
            throw new AppUserError(`Nothing of ${name} is live yet, so there are no logs.`, {
              cause: err,
            })
          }
          return viaEe(`read the logs of ${name}`, () => Promise.reject(err))
        }
      },
    },
    {
      name: 'website.app_deploy',
      module: WEBSITE_MODULE_ID,
      summary:
        "Deploy a connected GitHub repo + branch as an app on this server, or redeploy an app by name. The build contract comes from the repo's ee.json, else from `contract` (runtime, install, start, health). Health-gated and blue-green: a failing release never replaces the live one. The agent needs the owner's approval.",
      auditClass: 'mutate',
      // 'public': a deploy puts new code live at a reachable address (on a
      // server, the open internet). Under "reasonable" it still waits for the
      // owner, like publishing a page; only "allow all" lets it through.
      approvalRisk: 'public',
      activity: (input: z.infer<typeof deployInput>, output?: DeployResult) => {
        if (output) return `Deployed ${output.repo} (${output.branch}) as ${output.name}`
        if (input.repo && input.branch)
          return `Tried to deploy ${input.repo} (${input.branch}) as ${input.name}`
        return `Tried to deploy ${input.name}`
      },
      inputSchema: deployInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const author = deployer(ctx, 'website.app_deploy')
        return deploy(deployInput.parse(input), author)
      },
    },
    {
      name: 'website.app_env_set',
      module: WEBSITE_MODULE_ID,
      summary:
        "Set an environment variable for an app. The value is stored sealed by the server and never shown again; the app restarts with it (health-gated). The agent needs the owner's approval.",
      auditClass: 'mutate',
      // 'public': it restarts a live app with new configuration, a change visible to its users.
      approvalRisk: 'public',
      activity: (input: z.infer<typeof envSetInput>) => `Set ${input.key} on ${input.name}`,
      inputSchema: envSetInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const author = deployer(ctx, 'website.app_env_set')
        const i = envSetInput.parse(input)
        if (RESERVED_ENV.includes(i.key)) {
          throw new AppUserError(`${i.key} is set by the server itself and can't be changed here.`)
        }
        await mustService(i.name)
        const out = await viaEe(`store ${i.key}`, () =>
          ee.setSecret({ workload: i.name, name: i.key, value: i.value, author }),
        )
        if (out.reconcileError)
          console.error(`[website/apps] ${i.name} after setting ${i.key}: ${out.reconcileError}`)
        return { name: i.name, key: i.key, applied: out.reconcileError === null }
      },
    },
    {
      name: 'website.app_remove',
      module: WEBSITE_MODULE_ID,
      summary:
        'Stop and remove an app from this server, with its route (human only). The repo stays connected.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: (input: z.infer<typeof nameInput>) => `Removed the app ${input.name}`,
      inputSchema: nameInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'website.app_remove')
        const { name } = nameInput.parse(input)
        await mustService(name)
        const status = await viaEe('read the server status', () => ee.status())
        if (status.workloads.some((w) => w.name === name)) {
          await viaEe(`remove ${name}`, () => ee.removeApp({ name, author }))
        }
        await services.remove(name)
        return { name, removed: true }
      },
    },
    {
      name: 'website.app_auto_deploy',
      module: WEBSITE_MODULE_ID,
      summary:
        'Webhook path: deploy a push to every service built from that repo id + branch with push-to-deploy on.',
      auditClass: 'mutate',
      activity: (
        input: z.infer<typeof autoDeployInput>,
        output?: { deployed: { name: string }[] },
      ) => {
        if (!output) return `Deployed a push to ${input.repo}`
        if (output.deployed.length === 0)
          return `Received a push to ${input.repo}; no app deploys it automatically`
        return `Deployed a push to ${input.repo} to ${output.deployed.map((d) => d.name).join(', ')}`
      },
      inputSchema: autoDeployInput,
      permission: { roles: ['service'] },
      handler: async (ctx, input) => {
        if (ctx.principal.kind !== 'service') {
          throw new KernelError(
            'permission_denied',
            'website.app_auto_deploy is reserved for the GitHub webhook',
          )
        }
        const i = autoDeployInput.parse(input)
        // By GitHub's numeric id, so a renamed repo still deploys.
        const targets = (await services.list()).filter(
          (s) =>
            s.autoDeploy &&
            s.authKind === 'github_app' &&
            s.repoId === i.repoId &&
            s.branch === i.ref,
        )
        const deployed: Array<{ name: string; commit?: string; error?: string }> = []
        for (const s of targets) {
          try {
            const r = await deploy({ name: s.name }, 'github:auto-deploy')
            deployed.push({ name: s.name, commit: r.commit })
          } catch (err) {
            deployed.push({ name: s.name, error: err instanceof Error ? err.message : String(err) })
          }
        }
        return { deployed }
      },
    },
  ]
}
