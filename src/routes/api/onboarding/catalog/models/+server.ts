import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { getCatalogModelLists } from '$lib/server/llm/catalog'

/**
 * Model lists for a catalog provider id (chat + embedding), used by the wizard's
 * explicit model-selection step — subscription providers must never fall back to an
 * implicit default model.
 */
export const GET: RequestHandler = async (event) => {
  if (!event.locals.user) {
    return json({ error: 'You must be signed in.' }, { status: 401 })
  }

  const provider = event.url.searchParams.get('provider')?.trim().toLowerCase() ?? ''
  if (!provider) {
    return json({ error: 'provider query parameter is required.' }, { status: 400 })
  }

  try {
    const lists = await getCatalogModelLists(provider)
    if (!lists) {
      return json({ error: `Unknown provider: ${provider}` }, { status: 404 })
    }
    return json({ provider, ...lists })
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : 'Provider catalog unavailable.' },
      { status: 503 },
    )
  }
}
