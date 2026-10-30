import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { runViewAccess } from '$lib/server/agent-runs/access'
import { agentRunsSource } from '$lib/server/agent-runs/source'

/** /runs/[id] (D8): one run's metadata; the live feed streams client-side over SSE. */
export const load: PageServerLoad = async ({ locals, params }) => {
  const access = await runViewAccess(locals.user)
  if (!access.ok) {
    if (access.status === 401) throw redirect(302, '/login')
    throw error(access.status, access.error)
  }
  if (!/^[1-9]\d*$/.test(params.id)) throw error(400, `invalid run id: ${params.id}`)
  const id = Number(params.id)
  const run = (await agentRunsSource().list()).find((r) => r.id === id)
  if (!run) throw error(404, `unknown run ${id}`)
  return { run }
}
