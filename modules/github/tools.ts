import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { EeClient } from '$lib/server/ee/client'
import { requireHuman } from '$lib/server/ee/human'
import { GitHubApi } from './api'
import { defaultGitHubStore, type GitHubStore } from './store'

/**
 * GitHub → ee. Repos the company's GitHub App can see become apps on this box:
 * fetch the ref into ee's local mirror (token used for that one fetch), pin the
 * commit, and let ee build and deploy it behind the health gate.
 *
 * Human-only for anything that changes the box (D11). The single exception is
 * `github.auto_deploy`, run by the webhook's service principal — and only for
 * an app whose owner turned auto-deploy on (that switch IS the standing approval).
 */

export type GitHubToolDeps = { store?: GitHubStore; api?: GitHubApi; ee?: EeClient }

const NAME = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'app name: lowercase letters, digits, dashes (2–31)')
const REPO = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repository as owner/name')
const REF = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/)

const appCreateInput = z.object({
  name: NAME,
  repo: REPO,
  ref: REF.optional(),
  autoDeploy: z.boolean().default(false),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
  secrets: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
})
const appDeployInput = z.object({ name: NAME })
const autoDeployInput = z.object({ repo: REPO, ref: REF, after: z.string().regex(/^[0-9a-f]{40}$/) })

/** Mirror names are derived from the app name: one mirror per app. */
const mirrorName = (app: string) => `gh-${app}`

export function createGitHubTools(deps: GitHubToolDeps = {}): ToolDescriptor[] {
  const store = deps.store ?? defaultGitHubStore()
  const api = deps.api ?? new GitHubApi()
  const ee = deps.ee ?? new EeClient()

  async function installationToken(): Promise<string> {
    const conn = await store.connection()
    if (!conn) throw new Error('GitHub is not connected — connect it in Settings → Hosting')
    if (!conn.installationId) throw new Error(`the GitHub App ${conn.appSlug} is not installed on any account yet`)
    const creds = await store.credentials()
    return api.installationToken(conn.appId, creds.privateKeyPem, conn.installationId)
  }

  async function fetchRev(app: string, repo: string, ref: string): Promise<{ mirror: string; rev: string }> {
    const token = await installationToken()
    const out = await ee.fetchSource({ name: mirrorName(app), url: `https://github.com/${repo}.git`, ref, token })
    return { mirror: out.mirror, rev: out.rev }
  }

  return [
    {
      name: 'github.status',
      module: 'github',
      summary: 'Whether a GitHub App is connected and installed, and which apps on this server deploy from which repos.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => {
        const conn = await store.connection()
        return { connected: conn !== null, connection: conn, links: await store.links() }
      },
    },
    {
      name: 'github.repos_list',
      module: 'github',
      summary: "Repositories the company's GitHub App can see (and so can deploy).",
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => {
        const repos = await api.installationRepos(await installationToken())
        return repos.map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private }))
      },
    },
    {
      name: 'github.app_create',
      module: 'github',
      summary:
        'Deploy a repository as an app on this server (human only). The repo must contain ee.json; the app is health-gated before it takes traffic.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof appCreateInput>) => `Deployed ${input.repo} as the app “${input.name}”`,
      inputSchema: appCreateInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'github.app_create')
        const i = appCreateInput.parse(input)
        let ref = i.ref
        if (!ref) {
          const repos = await api.installationRepos(await installationToken())
          const found = repos.find((r) => r.full_name.toLowerCase() === i.repo.toLowerCase())
          if (!found) throw new Error(`the GitHub App cannot see ${i.repo} — add it to the installation on GitHub`)
          ref = found.default_branch
        }
        const { mirror, rev } = await fetchRev(i.name, i.repo, ref)
        await store.saveLink({ workload: i.name, repoFullName: i.repo, ref, autoDeploy: i.autoDeploy })
        const result = await ee.createApp({
          name: i.name,
          source: { kind: 'git', mirror, ref, rev },
          env: i.env,
          secrets: i.secrets,
          deploy: { auto: i.autoDeploy },
          author,
        })
        return { name: i.name, repo: i.repo, ref, commit: rev, stateRev: result.rev, reconcileError: result.reconcileError }
      },
    },
    {
      name: 'github.app_deploy',
      module: 'github',
      summary: "Deploy the latest commit of an app's branch (human only). Health-gated; a failing release never replaces the live one.",
      auditClass: 'mutate',
      activity: (input: z.infer<typeof appDeployInput>) => `Deployed the latest version of the app “${input.name}”`,
      inputSchema: appDeployInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'github.app_deploy')
        const { name } = appDeployInput.parse(input)
        const link = await store.link(name)
        if (!link) throw new Error(`${name} is not linked to a GitHub repository`)
        const { rev } = await fetchRev(name, link.repoFullName, link.ref)
        const result = await ee.deploy({ workload: name, rev, author })
        return { name, commit: rev, stateRev: result.rev, reconcileError: result.reconcileError }
      },
    },
    {
      name: 'github.auto_deploy',
      module: 'github',
      summary: 'Webhook path: deploy a pushed commit to every app linked to that repo+branch with auto-deploy on.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof autoDeployInput>, output?: { deployed: { name: string }[] }) => {
        if (!output) return `Deployed a push to ${input.repo}`
        if (output.deployed.length === 0) return `Received a push to ${input.repo}; no app deploys it automatically`
        return `Deployed a push to ${input.repo} to ${output.deployed.map((d) => `“${d.name}”`).join(', ')}`
      },
      inputSchema: autoDeployInput,
      permission: { roles: ['service'] },
      handler: async (ctx: ToolContext, input) => {
        if (ctx.principal.kind !== 'service') {
          throw new KernelError('permission_denied', 'github.auto_deploy is reserved for the GitHub webhook')
        }
        const i = autoDeployInput.parse(input)
        const targets = (await store.links()).filter(
          (l) => l.autoDeploy && l.ref === i.ref && l.repoFullName.toLowerCase() === i.repo.toLowerCase(),
        )
        const results = []
        for (const link of targets) {
          const { rev } = await fetchRev(link.workload, link.repoFullName, link.ref)
          const result = await ee.deploy({ workload: link.workload, rev, author: 'github:auto-deploy' })
          results.push({ name: link.workload, commit: rev, stateRev: result.rev, reconcileError: result.reconcileError })
        }
        return { deployed: results }
      },
    },
  ]
}
