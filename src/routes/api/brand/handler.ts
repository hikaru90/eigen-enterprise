import { randomUUID } from 'node:crypto'
import { error, json } from '@sveltejs/kit'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import { appKernel } from '$lib/server/boot'

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
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const field = issue?.path.join('.')
      error(400, field ? `${field}: ${issue.message}` : (issue?.message ?? 'Invalid input'))
    }
    if (err instanceof KernelError) {
      const problem = err.toProblemJson()
      return json(problem, { status: problem.status })
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
