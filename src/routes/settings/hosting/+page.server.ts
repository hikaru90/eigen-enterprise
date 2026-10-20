import { appKernel } from '$lib/server/boot'
import type { Actions, PageServerLoad } from './$types'
import { randomBytes, randomUUID } from 'node:crypto'
import { fail } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { requireAdmin } from '$lib/server/auth/require-admin'
import type { EeStatus } from '$lib/server/ee/client'
import { bootstrapKernel, ensureSystemModulesActive } from '../../../../modules/index'
import { GITHUB_STATE_COOKIE, githubAppManifest } from './manifest'

/**
 * Settings → Hosting: this server's domains, apps and GitHub connection.
 * Every change runs through the kernel registry as the signed-in human
 * (substrate/github tools are human-only, D11), so it is permission-checked,
 * audited, and committed to the company repo by ee.
 */

type Status = ({ managed: true } & EeStatus) | { managed: false; reason: string }
type GitHubStatus = {
  connected: boolean
  connection: { appSlug: string; htmlUrl: string; installationId: number | null } | null
  links: Array<{ workload: string; repoFullName: string; ref: string; autoDeploy: boolean }>
}

function ctx(user: { id: string }) {
  return {
    principal: { id: user.id, kind: 'human' as const, roles: ['admin'] },
    requestId: randomUUID(),
  }
}

async function run(user: { id: string }, tool: string, input: unknown): Promise<unknown> {
  const kernel = await appKernel()
  await ensureSystemModulesActive(kernel)
  return kernel.registry.execute(tool, input, ctx(user))
}

function failWith(err: unknown, action: string) {
  const message = err instanceof KernelError || err instanceof Error ? err.message : String(err)
  return fail(400, { action, error: message })
}

export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const status = (await run(user, 'substrate.status', {})) as Status
  const github = (await run(user, 'github.status', {})) as GitHubStatus
  let repos: Array<{ fullName: string; defaultBranch: string; private: boolean }> = []
  let reposError: string | null = null
  if (github.connection?.installationId) {
    try {
      repos = (await run(user, 'github.repos_list', {})) as typeof repos
    } catch (err) {
      reposError = err instanceof Error ? err.message : String(err)
    }
  }

  const state = randomBytes(16).toString('hex')
  event.cookies.set(GITHUB_STATE_COOKIE, state, {
    path: '/settings/hosting/github',
    httpOnly: true,
    sameSite: 'lax',
    secure: event.url.protocol === 'https:',
    maxAge: 60 * 30,
  })

  return {
    status,
    github,
    repos,
    reposError,
    githubState: state,
    githubManifest: JSON.stringify(
      githubAppManifest(event.url.origin, randomBytes(2).toString('hex')),
    ),
  }
}

export const actions: Actions = {
  addDomain: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    try {
      const out = (await run(user, 'substrate.domain_add', {
        host: String(f.get('host') ?? ''),
        role: String(f.get('role') ?? ''),
        workload: String(f.get('workload') || 'os'),
      })) as { reconcileError: string | null }
      return { action: 'addDomain', ok: true, reconcileError: out.reconcileError }
    } catch (err) {
      return failWith(err, 'addDomain')
    }
  },
  removeDomain: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    try {
      await run(user, 'substrate.domain_remove', { host: String(f.get('host') ?? '') })
      return { action: 'removeDomain', ok: true }
    } catch (err) {
      return failWith(err, 'removeDomain')
    }
  },
  createApp: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    try {
      const out = (await run(user, 'github.app_create', {
        name: String(f.get('name') ?? ''),
        repo: String(f.get('repo') ?? ''),
        ...(f.get('ref') ? { ref: String(f.get('ref')) } : {}),
        autoDeploy: f.get('autoDeploy') === 'on',
      })) as { reconcileError: string | null }
      return { action: 'createApp', ok: true, reconcileError: out.reconcileError }
    } catch (err) {
      return failWith(err, 'createApp')
    }
  },
  deployApp: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    try {
      const out = (await run(user, 'github.app_deploy', { name: String(f.get('name') ?? '') })) as {
        reconcileError: string | null
      }
      return { action: 'deployApp', ok: true, reconcileError: out.reconcileError }
    } catch (err) {
      return failWith(err, 'deployApp')
    }
  },
  removeApp: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    try {
      await run(user, 'substrate.app_remove', { name: String(f.get('name') ?? '') })
      return { action: 'removeApp', ok: true }
    } catch (err) {
      return failWith(err, 'removeApp')
    }
  },
  setSecret: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    try {
      const out = (await run(user, 'substrate.secret_set', {
        workload: String(f.get('workload') ?? ''),
        name: String(f.get('name') ?? ''),
        value: String(f.get('value') ?? ''),
      })) as { reconcileError: string | null }
      return { action: 'setSecret', ok: true, reconcileError: out.reconcileError }
    } catch (err) {
      return failWith(err, 'setSecret')
    }
  },
}
