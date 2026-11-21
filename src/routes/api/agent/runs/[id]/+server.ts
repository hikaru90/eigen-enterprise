import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { renameRunBody } from '$lib/agent-runs/rename'
import { runViewAccess } from '$lib/server/agent-runs/access'
import { agentRunsSource } from '$lib/server/agent-runs/source'
import { refusalReport } from '$lib/server/errors/report'

/**
 * Rename one conversation (Contribute 495e40bb). Any member may see every
 * run; only the run's owner may name it (the source enforces that).
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const attempted = `Renaming the conversation (agent run ${params.id})`
  const refuse = (sentence: string, status: number, cause?: string) =>
    json(
      refusalReport(sentence, {
        attempted,
        input: { runId: params.id },
        ...(cause ? { cause } : {}),
        nextSteps: [
          'The rename was refused by PATCH /api/agent/runs/[id] (src/routes/api/agent/runs/[id]/+server.ts); the HTTP status and the sentence say why.',
        ],
      }),
      { status },
    )
  const access = await runViewAccess(locals.user)
  if (!access.ok) return refuse(access.error, access.status)
  if (!/^[1-9]\d*$/.test(params.id)) return refuse(`invalid run id: ${params.id}`, 400)
  let raw: unknown
  try {
    raw = await request.json()
  } catch (err) {
    return refuse(
      'Request body must be JSON.',
      400,
      err instanceof Error ? err.message : String(err),
    )
  }
  const body = renameRunBody.safeParse(raw)
  if (!body.success) {
    const error = body.error.issues.map((issue) => issue.message).join(' ')
    return refuse(error, 400)
  }
  const result = await agentRunsSource().rename(access.userId, Number(params.id), body.data.title)
  if (!result.ok) return refuse(result.error, result.status)
  return json({ run: result.run })
}
