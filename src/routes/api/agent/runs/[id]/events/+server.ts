import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { runViewAccess } from '$lib/server/agent-runs/access'
import { agentRunsSource } from '$lib/server/agent-runs/source'
import { runEventsResponse } from '$lib/server/agent-runs/sse'

/**
 * D8 live feed of one durable run as Server-Sent Events: `snapshot` on
 * connect, then one `batch` per commit. Every connected browser gets its own
 * watcher on the same conversation, so all of them see the same stream.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  const access = await runViewAccess(locals.user)
  if (!access.ok) return json({ error: access.error }, { status: access.status })

  if (!/^[1-9]\d*$/.test(params.id)) {
    return json({ error: `invalid run id: ${params.id}` }, { status: 400 })
  }
  const runId = Number(params.id)
  const stream = await agentRunsSource().watch(runId)
  if (!stream) return json({ error: `unknown run ${runId}` }, { status: 404 })
  return runEventsResponse(stream, request.signal)
}
