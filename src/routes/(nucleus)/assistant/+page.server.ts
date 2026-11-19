import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { runViewAccess } from '$lib/server/agent-runs/access'
import { agentRunsSource } from '$lib/server/agent-runs/source'
import { countKnownDecisions } from '$lib/server/memory/known-decisions'

/**
 * /assistant (D8, polish P-1): the assistant's conversations (durable runs), newest activity first,
 * and how many decisions the member's own Memory knows ("Your Brain knows N decisions").
 */
export const load: PageServerLoad = async ({ locals }) => {
  const access = await runViewAccess(locals.user)
  if (!access.ok) {
    if (access.status === 401) throw redirect(302, '/login')
    throw error(access.status, access.error)
  }
  return {
    runs: await agentRunsSource().list(access.userId),
    knownDecisions: await countKnownDecisions(access.userId),
  }
}
