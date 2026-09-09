import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { executeBrandTool, parseJsonBody } from '../../../handler'

/**
 * Visual editor write path (phase-2d M6, V8): the owner's token edits land on
 * the DRAFT visual set through brand.visual_set_update in the kernel registry
 * (human-only guard, audit event, vcs commit). Auth is enforced here before
 * the tool runs — the same path MCP uses.
 */
export const GET: RequestHandler = async () => {
  error(405, 'Method not allowed')
}

const setIdSchema = z.string().uuid()

export const POST: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const setId = setIdSchema.safeParse(event.params.id)
  if (!setId.success) {
    error(400, 'setId must be a uuid')
  }
  const body = await parseJsonBody(event.request)
  return executeBrandTool(
    'brand.visual_set_update',
    { ...(typeof body === 'object' && body !== null ? body : {}), setId: setId.data },
    user,
  )
}
