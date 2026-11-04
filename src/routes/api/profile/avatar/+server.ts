import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { checkAvatar, MAX_AVATAR_BYTES } from '$lib/server/profile/avatar'
import { getProfile, saveAvatar } from '$lib/server/profile/service'

/**
 * POST the profile picture: the raw bytes of the square WebP the browser
 * cropped (Content-Type: image/webp). Checked (type, size, WebP header,
 * square 64–512 px), stored content-addressed, and the account's image
 * points at /api/people/avatar/<sha256>.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user || locals.apiKeyAuth) return json({ error: 'You must be signed in.' }, { status: 401 })
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
    return json({ error: `The picture is too large (at most ${MAX_AVATAR_BYTES / 1024} KB).` }, { status: 413 })
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  const check = checkAvatar(bytes, request.headers.get('content-type'))
  if (!check.ok) return json({ error: check.error }, { status: check.status })
  await saveAvatar(locals.user.id, bytes)
  return json({ profile: await getProfile(locals.user.id) })
}
