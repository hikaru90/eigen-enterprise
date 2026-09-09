import type { RequestHandler } from './$types'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { executeBrandTool, parseJsonBody } from '../handler'

export const GET: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  return executeBrandTool('brand.visual_set_list', {}, user)
}

export const POST: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const body = await parseJsonBody(event.request)
  return executeBrandTool('brand.visual_set_create', body, user)
}
