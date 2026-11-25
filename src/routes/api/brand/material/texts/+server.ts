import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { materialFailure } from '$lib/server/brand/material'
import { liveMaterialChat, suggestMaterialTexts } from '../../../../../../modules/brand/material/texts'
import { MaterialError, materialTextInputSchema } from '../../../../../../modules/brand/material/types'
import { defaultBrandStore } from '../../../../../../modules/brand/store'

/**
 * POST { formatId, brief?, locale? }: three copy variants for the piece in
 * the brand voice — the same as the brand.material_text_suggest tool. Saves
 * nothing. No AI provider → 503 with a plain sentence; the provider failing → 502.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) error(401, 'Sign in first.')
  const attempted = 'Writing texts for brand material (Brand › Material)'
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new MaterialError('invalid', 'The request body is not JSON.')
    }
    const i = materialTextInputSchema.parse(body)
    return json(
      await suggestMaterialTexts(
        { brand: defaultBrandStore(), chat: liveMaterialChat },
        { formatId: i.formatId, userId: locals.user.id, ...(i.brief ? { brief: i.brief } : {}), ...(i.locale ? { locale: i.locale } : {}) },
      ),
    )
  } catch (err) {
    const refused = materialFailure(attempted, err)
    if (refused) return refused
    throw err
  }
}
