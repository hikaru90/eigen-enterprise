import { randomUUID } from 'node:crypto'
import { error, json } from '@sveltejs/kit'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import { appKernel } from '$lib/server/boot'
import { errorReport, refusalReport } from '$lib/server/errors/report'

/**
 * Route-side executor for the brand selection wizard tools (phase-2d M4).
 * Auth is enforced by the route (requireAdmin) before this runs; the tool
 * call goes through the kernel registry so permission, human-only guard,
 * audit event and vcs commit all apply — the same path MCP uses.
 */
export async function executeBrandTool(
  name: string,
  input: unknown,
  user: { id: string },
  roles: string[] = ['admin'],
): Promise<Response> {
  try {
    const kernel = await appKernel()
    const result = await kernel.registry.execute(name, input, {
      principal: { id: user.id, kind: 'human', roles },
      requestId: randomUUID(),
    })
    return json(result)
  } catch (err) {
    const ctx = {
      attempted: `Changing the brand from the brand pages (${name})`,
      tool: name,
      input,
    }
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const field = issue?.path.join('.')
      const sentence = field ? `${field}: ${issue.message}` : (issue?.message ?? 'Invalid input')
      return json(
        {
          message: sentence,
          ...refusalReport(sentence, {
            ...ctx,
            cause: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          }),
        },
        { status: 400 },
      )
    }
    if (err instanceof KernelError) {
      // The problem JSON stays (type/title/status/detail); `error` + `agent` are the one error shape.
      const problem = err.toProblemJson()
      return json(
        { ...problem, ...errorReport(err, { ...ctx, plain: () => err.message }) },
        { status: problem.status },
      )
    }
    throw err
  }
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    error(400, 'Invalid JSON')
  }
}
