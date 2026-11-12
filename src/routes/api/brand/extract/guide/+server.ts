import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { checkGuideUpload, GuideUploadError } from '../../../../../../modules/brand/extract/guide'
import { executeBrandExtractTool, guideUploadErrorResponse } from '../handler'

/**
 * Upload a brand guide (multipart, field "file": PDF, PNG, JPEG or WebP) and
 * open an extraction session from it — the alternative to capturing a site.
 * The file is checked here first so a refused upload is answered with its
 * plain sentence before anything is encoded; brand.extract_guide_start checks
 * it again (the tool is also reachable over MCP and the CLI).
 */
export const GET: RequestHandler = async () => {
  error(405, 'Method not allowed')
}

export const POST: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  let form: FormData
  try {
    form = await event.request.formData()
  } catch {
    error(400, 'Send the brand guide as a multipart form with a "file" field.')
  }
  const file = form.get('file')
  if (!(file instanceof File)) error(400, 'Choose a brand guide file: a PDF, PNG, JPEG or WebP.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  try {
    checkGuideUpload({ filename: file.name, bytes })
  } catch (err) {
    if (err instanceof GuideUploadError) return guideUploadErrorResponse(err)
    throw err
  }
  return executeBrandExtractTool(
    'brand.extract_guide_start',
    { filename: file.name, dataB64: Buffer.from(bytes).toString('base64') },
    user,
  )
}
