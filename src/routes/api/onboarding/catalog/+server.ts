import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { getProviderCatalog } from '$lib/server/llm/catalog'

/** Catalog-driven provider list for the onboarding wizard (models.dev + EUrouter). */
export const GET: RequestHandler = async () => {
  try {
    const catalog = await getProviderCatalog()
    return json(catalog)
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : 'Provider catalog unavailable.' },
      { status: 503 },
    )
  }
}
