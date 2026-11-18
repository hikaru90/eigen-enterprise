import type { RequestHandler } from './$types'
import { liveSocial } from '$lib/server/brand/social'
import { personActor, socialJson } from '../../../../../../../modules/brand/social/http'

/** GET: an uploaded post's file (inline; ?download=1 saves it under its name). */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  personActor(locals.user)
  let file: { media: { mime: string; name: string }; bytes: Uint8Array } | undefined
  const failed = await socialJson(async () => {
    file = await liveSocial().media().readMedia(params.id)
  })
  if (!file) return failed
  const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline'
  return new Response(file.bytes as unknown as BodyInit, {
    headers: {
      'content-type': file.media.mime,
      'content-length': String(file.bytes.byteLength),
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.media.name)}`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  })
}
