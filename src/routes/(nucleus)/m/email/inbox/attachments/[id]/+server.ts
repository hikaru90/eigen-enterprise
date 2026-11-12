import type { RequestHandler } from './$types'
import { attachmentHeaders, downloadAttachment } from '../../../../../../../../modules/email/inbox/attachments'
import { InboxError } from '../../../../../../../../modules/email/inbox/errors'
import { isUuid } from '../../../../../../../../modules/email/inbox/url'

/**
 * One attachment of a received mail (S4): access-checked through the mail's
 * mailbox, the bytes read again from the raw mail. A download unless
 * `?inline=1` asks for an inline cid: image. Plain-text answers for the
 * cases a person can hit: not found (also "not yours"), blocked (virus).
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) return text(401, 'Sign in first.')
  if (!isUuid(params.id)) return text(404, 'No such attachment.')
  const { downloadDeps } = await import('../../../../../../../../modules/email/inbox/live')
  try {
    const file = await downloadAttachment(await downloadDeps(), locals.user.id, params.id, { inline: url.searchParams.get('inline') === '1' })
    return new Response(file.bytes, { headers: attachmentHeaders(file) })
  } catch (err) {
    if (err instanceof InboxError && err.code === 'not_found') return text(404, err.message)
    if (err instanceof InboxError && err.code === 'blocked') return text(403, err.message)
    if (err instanceof InboxError && err.code === 'not_kept') return text(410, err.message)
    throw err
  }
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } })
}
