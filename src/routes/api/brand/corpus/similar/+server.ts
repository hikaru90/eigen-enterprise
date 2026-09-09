import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { executeBrandTool, parseJsonBody } from '../../handler'

/**
 * Tree navigation endpoint (phase-2d M7): ranked "more like this" for one
 * corpus item, served from the precomputed k-NN via brand.corpus_similar.
 * GET takes itemId (+limit) from the query string; POST takes a JSON body —
 * both delegate through the kernel registry like every brand route.
 */
export const GET: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const itemId = event.url.searchParams.get('itemId')
  const limit = event.url.searchParams.get('limit')
  if (!itemId) error(400, 'itemId is required')
  return executeBrandTool(
    'brand.corpus_similar',
    { itemId, ...(limit === null ? {} : { limit: Number(limit) }) },
    user,
  )
}

export const POST: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const body = await parseJsonBody(event.request)
  return executeBrandTool('brand.corpus_similar', body, user)
}
