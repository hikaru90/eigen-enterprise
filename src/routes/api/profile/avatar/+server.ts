import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { checkAvatar, MAX_AVATAR_BYTES } from '$lib/server/profile/avatar'
import { getProfile, saveAvatar } from '$lib/server/profile/service'
import { refusalReport } from '$lib/server/errors/report'

/** A refused picture: the sentence for the person + the agent half. */
function refuse(sentence: string, status: number, input?: unknown) {
  return json(
    refusalReport(sentence, {
      attempted: 'Uploading your profile picture (POST /api/profile/avatar)',
      ...(input !== undefined ? { input } : {}),
      nextSteps: [
        'POST /api/profile/avatar refused the picture before storing it; checkAvatar (src/lib/server/profile/avatar.ts) checks type, size, WebP header and the square 64–512 px shape.',
      ],
    }),
    { status },
  )
}

/**
 * POST the profile picture: the raw bytes of the square WebP the browser
 * cropped (Content-Type: image/webp). Checked (type, size, WebP header,
 * square 64–512 px), stored content-addressed, and the account's image
 * points at /api/people/avatar/<sha256>.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user || locals.apiKeyAuth) return refuse('You must be signed in.', 401)
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
    return refuse(`The picture is too large (at most ${MAX_AVATAR_BYTES / 1024} KB).`, 413, {
      contentLength: declared,
    })
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  const check = checkAvatar(bytes, request.headers.get('content-type'))
  if (!check.ok) {
    return refuse(check.error, check.status, {
      contentType: request.headers.get('content-type'),
      bytes: bytes.length,
    })
  }
  await saveAvatar(locals.user.id, bytes)
  return json({ profile: await getProfile(locals.user.id) })
}
