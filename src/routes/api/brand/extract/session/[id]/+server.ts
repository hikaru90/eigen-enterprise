import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { executeBrandExtractTool } from '../../handler'

const sessionIdSchema = z.string().uuid()

export const POST: RequestHandler = async () => {
  error(405, 'Method not allowed')
}

export const GET: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const sessionId = sessionIdSchema.safeParse(event.params.id)
  if (!sessionId.success) {
    error(400, 'sessionId must be a uuid')
  }
  return executeBrandExtractTool('brand.extract_session_get', { sessionId: sessionId.data }, user)
}
