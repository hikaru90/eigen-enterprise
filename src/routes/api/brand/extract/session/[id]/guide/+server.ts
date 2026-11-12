import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { defaultBrandExtractionStore } from '../../../../../../../../modules/brand/extract/store'

const sessionIdSchema = z.string().uuid()

/**
 * The uploaded brand guide of a guide session, inline: the owner compares the
 * proposed looks against it, as a URL session compares against the capture
 * screenshot. Images are served sandboxed; the PDF is not (Chrome's PDF
 * viewer refuses a sandboxed document — same rule as Drive's preview).
 */
export const GET: RequestHandler = async (event) => {
  await requireAdmin(event.locals.user)
  const sessionId = sessionIdSchema.safeParse(event.params.id)
  if (!sessionId.success) error(400, 'sessionId must be a uuid')
  const guide = await defaultBrandExtractionStore().getGuide(sessionId.data)
  if (!guide) error(404, 'This extraction session has no brand guide.')
  const bytes = Buffer.from(guide.base64, 'base64')
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': guide.mime,
      'content-length': String(bytes.byteLength),
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(guide.filename)}`,
      'x-content-type-options': 'nosniff',
      ...(guide.mime === 'application/pdf'
        ? {}
        : {
            'content-security-policy':
              "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
          }),
      'cache-control': 'private, no-store',
    },
  })
}
