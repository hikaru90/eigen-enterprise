import type { Actions, PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { fail } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { requireCapability } from '$lib/server/auth/require-capability'
import { getUserRole } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { ownerRun } from '$lib/server/website/owner-run'
import type { ModuleListItem } from '../../../../../../modules/company-modules/service'

/**
 * Settings → Plugins → Company modules (plan/phase-upgrades-u2.md §8): the
 * company's own modules, where each stands and why, the owner's one-time
 * sharing OK, a deploy that waits for an admin's own click, and removal.
 * A client of the modules.* registry tools, as the signed-in person — the
 * path the CLI, MCP and the assistant use. Switching one on or off is on
 * Settings → Plugins (kernel.module_activate / module_deactivate).
 */

const REASON = 'Only the owner or an admin manages the company modules.'

export type CompanyModulesData = {
  modules: ModuleListItem[]
  sharing: { by: string; at: string } | null
  isOwner: boolean
}

function personCtx(user: { id: string }): ToolContext {
  return { principal: { id: user.id, kind: 'human', roles: ['admin'] }, requestId: randomUUID() }
}

export const load: PageServerLoad = async ({ locals }): Promise<CompanyModulesData> => {
  const { user } = await requireCapability(locals, 'modules.manage', REASON)
  const kernel = await appKernel()
  const listed = (await kernel.registry.execute('modules.list', {}, personCtx(user))) as {
    modules: ModuleListItem[]
    sharing: { by: string; at: string } | null
  }
  return { ...listed, isOwner: (await getUserRole(user.id)) === 'owner' }
}

type Act = 'acceptSharing' | 'deploy' | 'remove'

const TOOL: Record<Act, string> = {
  acceptSharing: 'modules.accept_sharing',
  deploy: 'modules.deploy',
  remove: 'modules.remove',
}

const ATTEMPTED: Record<Act, string> = {
  acceptSharing: 'Agreeing that modules built here are open source and shared (Settings → Company modules)',
  deploy: 'Deploying a company module (Settings → Company modules)',
  remove: 'Removing a company module (Settings → Company modules)',
}

async function act(action: Act, { locals, request }: Parameters<Actions[string]>[0]) {
  const { user } = await requireCapability(locals, 'modules.manage', REASON)
  const form = await request.formData()
  const id = form.get('id')
  const commit = form.get('commit')
  let input: Record<string, string>
  if (action === 'acceptSharing') input = {}
  else if (typeof id !== 'string' || id === '') {
    return fail(400, { action, id: null, ...refusalReport('Choose a module.', { attempted: ATTEMPTED[action], nextSteps: ['The form sent no id: a bug in src/routes/(nucleus)/settings/modules/company/+page.svelte.'] }) })
  } else if (action === 'deploy') {
    if (typeof commit !== 'string' || commit === '') {
      return fail(400, { action, id, ...refusalReport('Choose a commit.', { attempted: ATTEMPTED[action], nextSteps: ['The form sent no commit.'] }) })
    }
    input = { id, commit }
  } else input = { id }
  try {
    // The person's click is their decision: a gated deploy, or the always-ask removal, is approved by it.
    await ownerRun(user, TOOL[action], input)
    return { action, id: input.id ?? null, ok: true as const }
  } catch (err) {
    if (err instanceof KernelError) {
      return fail(err.toProblemJson().status, {
        action,
        id: input.id ?? null,
        ...errorReport(err, { attempted: ATTEMPTED[action], tool: TOOL[action], input, plain: (e) => (e as Error).message }),
      })
    }
    throw err
  }
}

export const actions: Actions = {
  acceptSharing: (event) => act('acceptSharing', event),
  deploy: (event) => act('deploy', event),
  remove: (event) => act('remove', event),
}
