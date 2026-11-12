import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { companyStorage } from '$lib/server/company/live'
import { readCompanyLogo } from '$lib/server/company/service'

/**
 * The company logo (Settings → Company), for signed-in members only — like
 * profile pictures. The URL names the bytes (SHA-256), so a response never
 * changes: cached privately for a year. Only the current logo is served.
 * The CSP sandboxes the response: an SVG opened on its own can't run script
 * or load anything (it was sanitized on upload; this is the second wall).
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user || locals.apiKeyAuth) error(401, 'You must be signed in.')
  const logo = await readCompanyLogo(params.sha, companyStorage())
  if (!logo) error(404, 'No such logo.')
  const etag = `"${params.sha}"`
  const headers = {
    'content-type': logo.mime,
    'cache-control': 'private, max-age=31536000, immutable',
    etag,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  return new Response(logo.bytes.slice().buffer as ArrayBuffer, {
    headers: { ...headers, 'content-length': String(logo.bytes.byteLength) },
  })
}
