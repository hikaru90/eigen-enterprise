import type { Actions, PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { fail } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { requireCapability } from '$lib/server/auth/require-capability'
import { appKernel } from '$lib/server/boot'
import { ownerRun } from '$lib/server/website/owner-run'
import { ownerModuleBlurb } from '$lib/shell/module-copy'
import { CONTRIBUTE_HUB_MODULE_ID } from '../../../../../modules/contribute/hub/manifest'

/**
 * Settings → Plugins (owner, 2026-11-12: "everything is a plugin"): every
 * plugin the kernel knows — each module with a sidebar entry — on or off, who
 * needs whom, and a switch. The core (the kernel and the internal modules)
 * is one line: it cannot be switched off. Owner and admins only.
 *
 * Every read and switch goes through the kernel registry (kernel.module_list
 * / module_activate / module_deactivate) as the signed-in person — the path
 * the MCP and the agent use — so permission, approvals, audit and events
 * apply. The person's click is their decision: when the approval mode gates
 * a switch-off, the click is recorded as their approval (ownerRun). What the
 * kernel refuses (the core, a plugin another needs) is shown in its words.
 */

const REASON = 'Only the owner or an admin can switch plugins on and off.'

/** What kernel.module_list answers per module. */
type ListedModule = {
  id: string
  name: string
  version: string
  description?: string
  internal?: true
  tools: string[]
  active: boolean
  core: boolean
  requires: string[]
  requiredBy: string[]
}

/**
 * Where a plugin comes from. Official plugins ship with eigenEnterprise and
 * are only ever switched on or off (never removed or edited); a company's own
 * plugins are added alongside them (phase-extensions) — not built yet, so the
 * kernel knows only official ones today.
 */
export type PluginOrigin = 'official' | 'company'

export type PluginRef = { id: string; name: string; active: boolean }

export type PluginRow = {
  id: string
  name: string
  version: string
  /** The owner-facing one-liner; null when the module has none. */
  description: string | null
  origin: PluginOrigin
  active: boolean
  /** The agent tools it brings: switched off, the agent can no longer use them. */
  tools: string[]
  /** Plugins it needs switched on. */
  requires: PluginRef[]
  /** Plugins that need it. */
  requiredBy: PluginRef[]
}

export type PluginsData = { plugins: PluginRow[]; core: { id: string; name: string }[] }

function personCtx(user: { id: string }): ToolContext {
  // Callers passed requireCapability first: owner or admin.
  return { principal: { id: user.id, kind: 'human', roles: ['admin'] }, requestId: randomUUID() }
}

export const load: PageServerLoad = async ({ locals }): Promise<PluginsData> => {
  const { user } = await requireCapability(locals, 'modules.manage', REASON)
  const kernel = await appKernel()
  const listed = (await kernel.registry.execute('kernel.module_list', {}, personCtx(user))) as ListedModule[]
  const byId = new Map(listed.map((m) => [m.id, m]))
  // A required module the kernel has not registered (a boot stage that is off) is named by its id, and off.
  const ref = (id: string): PluginRef => ({ id, name: byId.get(id)?.name ?? id, active: byId.get(id)?.active === true })
  return {
    plugins: listed
      .filter((m) => !m.core)
      .map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        description: ownerModuleBlurb(m.id, m.description ?? '') || null,
        origin: 'official',
        active: m.active,
        tools: m.tools,
        requires: m.requires.map(ref),
        requiredBy: m.requiredBy.map(ref),
      })),
    // The central Contribute board is internal but switched on only on the owner's install:
    // where it is off, it is not part of this company's core.
    core: listed
      .filter((m) => m.core && (m.active || m.id !== CONTRIBUTE_HUB_MODULE_ID))
      .map((m) => ({ id: m.id, name: m.name })),
  }
}

type SwitchAction = 'activate' | 'deactivate'

const TOOLS: Record<SwitchAction, string> = {
  activate: 'kernel.module_activate',
  deactivate: 'kernel.module_deactivate',
}

async function flip(action: SwitchAction, { locals, request }: Parameters<Actions[string]>[0]) {
  const { user } = await requireCapability(locals, 'modules.manage', REASON)
  const moduleId = (await request.formData()).get('module_id')
  if (typeof moduleId !== 'string' || moduleId === '') {
    return fail(400, { action, moduleId: null, error: 'Choose a plugin.' })
  }
  try {
    await ownerRun(user, TOOLS[action], { module_id: moduleId })
    return { action, moduleId, ok: true as const }
  } catch (err) {
    if (err instanceof KernelError) {
      return fail(err.toProblemJson().status, { action, moduleId, error: err.message })
    }
    throw err
  }
}

export const actions: Actions = {
  activate: (event) => flip('activate', event),
  deactivate: (event) => flip('deactivate', event),
}
