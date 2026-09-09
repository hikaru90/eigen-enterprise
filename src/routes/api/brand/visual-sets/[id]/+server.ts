import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { executeBrandTool } from '../../handler'

const setIdSchema = z.string().uuid()

export const POST: RequestHandler = async () => {
  error(405, 'Method not allowed')
}

export const GET: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const setId = setIdSchema.safeParse(event.params.id)
  if (!setId.success) {
    error(400, 'setId must be a uuid')
  }
  return executeBrandTool('brand.visual_set_get', { setId: setId.data }, user)
}
