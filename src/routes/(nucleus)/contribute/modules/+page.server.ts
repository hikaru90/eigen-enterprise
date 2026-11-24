import type { HubFileContent, HubModuleDetail, HubModuleListItem, HubVersionDetail } from '../../../../../modules/module-hub/types'
import type { Actions, PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { error, fail, redirect } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import type { ToolPrincipal } from '$lib/kernel/types'
import { getUserRole, kernelRolesFor } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { HubError } from '../../../../../modules/contribute/hub/errors'

/**
 * Contribute → Modules (plan/phase-upgrades-u2.md §7), on the module hub's
 * box: every module installs published — the list, one module's versions and
 * the installs running it, a version's manifest, files and summary, and one
 * file's code. A client of the module_hub.* registry tools, run as the
 * signed-in person with their own kernel roles (the agent and `ee` read the
 * same). 404 while the module-hub module is off; the tools' own roles decide
 * who may read (admins).
 *
 * URL: ?q= filters the list, ?install=&module= opens a module, &sha= a
 * version, &path= a file of it.
 */

async function principal(locals: App.Locals): Promise<ToolPrincipal> {
  if (!locals.user) throw redirect(302, '/login')
  const role = await getUserRole(locals.user.id)
  if (!role) throw error(403, 'Only a member of this company reads the module hub.')
  return { id: locals.user.id, kind: 'human', roles: kernelRolesFor(role) }
}

async function call<T>(p: ToolPrincipal, tool: string, input: Record<string, unknown>): Promise<T> {
  const kernel = await appKernel()
  return (await kernel.registry.execute(tool, input, { principal: p, requestId: randomUUID() })) as T
}

function readError(err: unknown): never {
  if (err instanceof KernelError && err.code === 'module_inactive') throw error(404, 'Not found')
  if (err instanceof KernelError && err.code === 'permission_denied') throw error(403, 'Only an admin reads the module hub.')
  if (err instanceof HubError && err.code === 'not_found') throw error(404, err.message)
  if (err instanceof HubError && err.code === 'invalid') throw error(400, err.message)
  throw err
}

const param = (url: URL, key: string) => url.searchParams.get(key)?.trim() || undefined

export const load: PageServerLoad = async ({ locals, url }) => {
  const p = await principal(locals)
  const query = param(url, 'q')
  const cursor = param(url, 'cursor')
  const install = param(url, 'install')
  const moduleId = param(url, 'module')
  const sha = param(url, 'sha')
  const path = param(url, 'path')
  try {
    const list = await call<{ modules: HubModuleListItem[]; cursor: string | null }>(p, 'module_hub.list', { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) })
    const detail = install && moduleId ? await call<HubModuleDetail>(p, 'module_hub.get', { install_id: install, module_id: moduleId }) : null
    const versionSha = sha ?? detail?.module.latestBundleSha256
    const version = versionSha ? await call<HubVersionDetail>(p, 'module_hub.version', { bundle_sha256: versionSha }) : null
    const tree = versionSha ? await call<{ files: { path: string; size: number; mode: number }[] }>(p, 'module_hub.tree', { bundle_sha256: versionSha }) : null
    const file = versionSha && path ? await call<HubFileContent>(p, 'module_hub.file', { bundle_sha256: versionSha, path }) : null
    return { query: query ?? '', list, detail, version, files: tree?.files ?? [], file, canSummarize: p.roles.includes('admin') }
  } catch (err) {
    readError(err)
  }
}

export const actions: Actions = {
  summarize: async ({ locals, request }) => {
    const p = await principal(locals)
    const sha = String((await request.formData()).get('bundle_sha256') ?? '')
    try {
      await call(p, 'module_hub.summarize', { bundle_sha256: sha })
      return { summarized: sha }
    } catch (err) {
      if (err instanceof KernelError && (err.code === 'permission_denied' || err.code === 'approval_required' || err.code === 'invalid_input')) {
        return fail(err.code === 'invalid_input' ? 400 : 403, { error: err.message })
      }
      if (err instanceof HubError) return fail(err.code === 'not_found' ? 404 : 400, { error: err.message })
      return fail(502, { error: err instanceof Error ? err.message : String(err) })
    }
  },
}
