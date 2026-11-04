import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { AVATAR_MIME } from '$lib/server/profile/avatar'
import { readAvatar } from '$lib/server/profile/service'

/**
 * A profile picture, for signed-in members only. The URL names the bytes
 * (SHA-256), so a response never changes: cached privately for a year.
 * Only pictures someone currently uses are served.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user || locals.apiKeyAuth) error(401, 'You must be signed in.')
  const sha = params.sha
  const etag = `"${sha}"`
  const bytes = await readAvatar(sha)
  if (!bytes) error(404, 'No such profile picture.')
  const headers = {
    'content-type': AVATAR_MIME,
    'cache-control': 'private, max-age=31536000, immutable',
    etag,
    'x-content-type-options': 'nosniff',
  }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    headers: { ...headers, 'content-length': String(bytes.byteLength) },
  })
}
