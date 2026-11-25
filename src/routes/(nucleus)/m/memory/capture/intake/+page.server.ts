import type { PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { error, redirect } from '@sveltejs/kit'
import { BRAIN_INTAKE_LIMIT, type BrainIntake } from '$lib/memory/brain-intake'
import { getUserRole, kernelRolesFor } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'

/**
 * Memory › What the brain took in (Contribute 30a8d920 part 2): a client of the
 * memory.intake registry tool, run as the signed-in person with their own kernel
 * roles — the same read the ee CLI, MCP and the assistant get.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, '/login')
  const userId = locals.user.id
  const role = await getUserRole(userId)
  if (!role) throw error(403, 'Only a member of this company has a Memory here.')
  const kernel = await appKernel()
  const intake = (await kernel.registry.execute(
    'memory.intake',
    { limit: BRAIN_INTAKE_LIMIT },
    {
      principal: { id: userId, kind: 'human', roles: kernelRolesFor(role) },
      requestId: randomUUID(),
    },
  )) as BrainIntake
  return { intake, limit: BRAIN_INTAKE_LIMIT }
}
