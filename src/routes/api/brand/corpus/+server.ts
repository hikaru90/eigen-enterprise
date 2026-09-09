import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { executeBrandTool } from '../handler'

export const POST: RequestHandler = async () => {
  error(405, 'Method not allowed')
}

export const GET: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  return executeBrandTool('brand.corpus_list', {}, user)
}
