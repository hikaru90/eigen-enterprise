import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { avatarUrl } from '$lib/profile/profile'
import { requireCapability } from '$lib/server/auth/require-capability'
import { refusalReport } from '$lib/server/errors/report'
import { avatarBlobs, MAX_AVATAR_BYTES, stageCoworkerAvatar } from '$lib/server/profile/avatar'

const REASON = 'Only the owner or an admin can upload AI co-worker avatars.'

/** A refused picture: the sentence for the person + the agent half. */
function refuse(sentence: string, status: number, input?: unknown) {
  return json(
    refusalReport(sentence, {
      attempted: 'Uploading an AI co-worker avatar (POST /api/people/avatar/upload)',
      ...(input !== undefined ? { input } : {}),
      nextSteps: [
        'POST /api/people/avatar/upload refused the picture before storing it; stageCoworkerAvatar / checkAvatar (src/lib/server/profile/avatar.ts) check type, size, WebP header and the square 64–512 px shape.',
      ],
    }),
    { status },
  )
}

/**
 * POST a custom AI co-worker avatar: raw bytes of a square WebP (64–512 px,
 * Content-Type: image/webp). Admin-only (coworkers.manage). A thin client of
 * stageCoworkerAvatar (the coworkers.avatar_upload tool uses the same), returns
 * { sha256, image: avatarUrl(sha256) }. No user row changes until saved via
 * coworkers.create or coworkers.update.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user || locals.apiKeyAuth) return refuse('You must be signed in.', 401)
  await requireCapability(locals, 'coworkers.manage', REASON)
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
    return refuse(`The picture is too large (at most ${MAX_AVATAR_BYTES / 1024} KB).`, 413, {
      contentLength: declared,
    })
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  const staged = await stageCoworkerAvatar(bytes, request.headers.get('content-type'), avatarBlobs())
  if (!staged.ok) {
    return refuse(staged.error, staged.status, {
      contentType: request.headers.get('content-type'),
      bytes: bytes.length,
    })
  }
  return json({ sha256: staged.sha256, image: avatarUrl(staged.sha256) })
}
