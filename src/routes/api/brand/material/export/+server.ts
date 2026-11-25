import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { currentCompanyLogo, materialFailure } from '$lib/server/brand/material'
import { exportMaterial } from '../../../../../../modules/brand/material/export'
import { MaterialError, materialExportInputSchema } from '../../../../../../modules/brand/material/types'
import { defaultBrandStore } from '../../../../../../modules/brand/store'

/**
 * POST { formatId, mode?, headline, body?, cta?, logo? }: the piece as a
 * print-ready file (PDF or PNG) to download — the same export as the
 * brand.material_export tool. Any signed-in member. Saves nothing.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) error(401, 'Sign in first.')
  const attempted = 'Exporting brand material (Brand › Material)'
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new MaterialError('invalid', 'The request body is not JSON.')
    }
    const file = await exportMaterial({ visualSets: defaultBrandStore(), logo: currentCompanyLogo }, materialExportInputSchema.parse(body))
    return new Response(Buffer.from(file.bytes), {
      headers: {
        'content-type': file.mime,
        'content-length': String(file.sizeBytes),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'cache-control': 'no-store',
      },
    })
  } catch (err) {
    const refused = materialFailure(attempted, err)
    if (refused) return refused
    throw err
  }
}
