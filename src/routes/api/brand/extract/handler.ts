import { randomUUID } from 'node:crypto'
import { error, json } from '@sveltejs/kit'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import { appKernel } from '$lib/server/boot'
import { errorReport, refusalReport } from '$lib/server/errors/report'
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
    const ctx: ExtractCtx = {
      attempted: `Extracting a brand style (${name})`,
      tool: name,
      input: compactInput(input),
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
      const problem = err.toProblemJson()
      return json(
        { ...problem, ...errorReport(err, { ...ctx, plain: () => err.message }) },
        { status: problem.status },
      )
    }
    const typed = brandExtractErrorResponse(err, ctx)
    if (typed) return typed
    throw err
  }
}

/** What the agent report says was attempted. */
export type ExtractCtx = { attempted: string; tool?: string; input?: unknown }

/** The input for a report: long strings (a guide's base64 bytes, a screenshot) are left out by length. */
function compactInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) => [
      k,
      typeof v === 'string' && v.length > 1000 ? `[${v.length} characters left out]` : v,
    ]),
  )
}

/**
 * The extraction's typed failures as plain answers: no browser on this server
 * (503 — capture can't run here, the guide upload can), a refused brand guide
 * (its own 400/413/415). Anything else is not answered here.
 */
export function brandExtractErrorResponse(err: unknown, ctx: ExtractCtx): Response | null {
  if (err instanceof BrowserUnavailableError) {
    return json(
      {
        message: err.message,
        code: err.code,
        ...errorReport(err, {
          ...ctx,
          plain: () => err.message,
          nextSteps: [
            'Capturing a website needs a headless browser on this server; install it as the owner directs, or upload a brand guide instead.',
          ],
        }),
      },
      { status: 503 },
    )
  }
  if (err instanceof GuideUploadError) return guideUploadErrorResponse(err, ctx)
  return null
}

export function guideUploadErrorResponse(err: GuideUploadError, ctx: ExtractCtx): Response {
  return json(
    {
      message: err.message,
      code: err.code,
      ...errorReport(err, { ...ctx, plain: () => err.message }),
    },
    { status: err.status },
  )
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    error(400, 'Invalid JSON')
  }
}
