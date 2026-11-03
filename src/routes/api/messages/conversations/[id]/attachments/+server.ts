import type { RequestHandler } from './$types'
import { messagesRoute } from '../../../../../../../modules/messages/http'
import { MessagesError, uploadAttachments } from '../../../../../../../modules/messages/service'

/**
 * Upload files to attach (multipart: file × n) into the conversation's Drive
 * folder ("Messages / #channel", created on first use with the channel's
 * access). Each file is checked on its own against the Drive's size limit:
 * { uploaded, errors } — then post the message with the uploaded fileIds.
 */
export const POST: RequestHandler = ({ locals, params, request }) =>
  messagesRoute(locals.user, async (userId, d) => {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      throw new MessagesError('invalid', 'send the files as a multipart form')
    }
    const files = form.getAll('file').filter((f): f is File => f instanceof File)
    return uploadAttachments(
      d,
      userId,
      params.id,
      await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type || null, bytes: new Uint8Array(await f.arrayBuffer()) }))),
    )
  })
