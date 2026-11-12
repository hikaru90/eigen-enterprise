import { appKernel } from '$lib/server/boot'
import { randomUUID } from 'node:crypto'
import { error, json } from '@sveltejs/kit'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import { BrowserUnavailableError } from '../../../../../modules/brand/extract/capture-errors'
import { GuideUploadError } from '../../../../../modules/brand/extract/guide'

/**
 * Route-side executor for the brand extraction tools (phase-2d M2).
 * Auth is enforced by the route (requireAdmin) before this runs; the tool
 * call goes through the kernel registry so permission, human-only guard,
 * audit event and vcs commit all apply — the same path MCP uses.
 */
export async function executeBrandExtractTool(
  name: string,
  input: unknown,
  user: { id: string },
): Promise<Response> {
  try {
    const kernel = await appKernel()
    const result = await kernel.registry.execute(name, input, {
      principal: { id: user.id, kind: 'human', roles: ['admin'] },
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
    const typed = brandExtractErrorResponse(err)
    if (typed) return typed
    throw err
  }
}

/**
 * The extraction's typed failures as plain answers: no browser on this server
 * (503 — capture can't run here, the guide upload can), a refused brand guide
 * (its own 400/413/415). Anything else is not answered here.
 */
export function brandExtractErrorResponse(err: unknown): Response | null {
  if (err instanceof BrowserUnavailableError) {
    return json({ message: err.message, code: err.code }, { status: 503 })
  }
  if (err instanceof GuideUploadError) return guideUploadErrorResponse(err)
  return null
}

export function guideUploadErrorResponse(err: GuideUploadError): Response {
  return json({ message: err.message, code: err.code }, { status: err.status })
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    error(400, 'Invalid JSON')
  }
}
