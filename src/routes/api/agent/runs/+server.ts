import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { runViewAccess } from '$lib/server/agent-runs/access'
import { agentRunsSource } from '$lib/server/agent-runs/source'

/** D8: the company's durable agent runs (conversation index metadata only). */
export const GET: RequestHandler = async ({ locals }) => {
  const access = await runViewAccess(locals.user)
  if (!access.ok) return json({ error: access.error }, { status: access.status })
  return json({ runs: await agentRunsSource().list() })
}
