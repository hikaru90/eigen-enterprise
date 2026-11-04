import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { runViewAccess } from '$lib/server/agent-runs/access'
import { agentRunsSource } from '$lib/server/agent-runs/source'

/** /assistant (D8, polish P-1): the assistant's conversations (durable runs), newest activity first. */
export const load: PageServerLoad = async ({ locals }) => {
  const access = await runViewAccess(locals.user)
  if (!access.ok) {
    if (access.status === 401) throw redirect(302, '/login')
    throw error(access.status, access.error)
  }
  return { runs: await agentRunsSource().list() }
}
