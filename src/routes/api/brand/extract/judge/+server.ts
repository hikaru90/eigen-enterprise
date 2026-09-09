import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { executeBrandExtractTool, parseJsonBody } from '../handler'

export const GET: RequestHandler = async () => {
  error(405, 'Method not allowed')
}

export const POST: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const body = await parseJsonBody(event.request)
  return executeBrandExtractTool('brand.extract_judge', body, user)
}
