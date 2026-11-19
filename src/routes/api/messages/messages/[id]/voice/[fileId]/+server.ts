import type { RequestHandler } from './$types'
import { messagesRoute, rangedResponse } from '../../../../../../../../modules/messages/http'
import { readVoiceClip } from '../../../../../../../../modules/messages/service'

/**
 * A voice message's recording, for the player above its transcript: only to people who
 * may see the conversation (anyone else: 404). Served inline as the recorder's own audio,
 * with byte ranges (the player seeks), never sniffed as anything else, never cached.
 */
export const GET: RequestHandler = ({ locals, params, request }) =>
  messagesRoute(locals.user, async (userId, d) => {
    const { mime, bytes } = await readVoiceClip(d, userId, params.id, params.fileId)
    return rangedResponse(request, bytes, {
      'content-type': mime,
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
    })
  })
