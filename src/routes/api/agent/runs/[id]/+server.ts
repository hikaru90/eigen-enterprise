import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { renameRunBody } from '$lib/agent-runs/rename'
import { runViewAccess } from '$lib/server/agent-runs/access'
import { agentRunsSource } from '$lib/server/agent-runs/source'

/**
 * Rename one conversation (Contribute 495e40bb). Any member may see every
 * run; only the run's owner may name it (the source enforces that).
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const access = await runViewAccess(locals.user)
  if (!access.ok) return json({ error: access.error }, { status: access.status })
  if (!/^[1-9]\d*$/.test(params.id)) {
    return json({ error: `invalid run id: ${params.id}` }, { status: 400 })
  }
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const body = renameRunBody.safeParse(raw)
  if (!body.success) {
    const error = body.error.issues.map((issue) => issue.message).join(' ')
    return json({ error }, { status: 400 })
  }
  const result = await agentRunsSource().rename(access.userId, Number(params.id), body.data.title)
  if (!result.ok) return json({ error: result.error }, { status: result.status })
  return json({ run: result.run })
}
