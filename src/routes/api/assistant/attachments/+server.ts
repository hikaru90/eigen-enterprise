import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { dbScopedGatewayComplete } from '$lib/server/agent/db-scoped-complete'
import {
  AssistantAttachmentError,
  readAssistantAttachment,
} from '$lib/server/assistant/attachments'

/**
 * Attach one file to the assistant composer (multipart: `file`). Reads it now — a text file as
 * is, a PDF or an image by the company's chat model, attributed to the member — and returns
 * the attachment the composer sends with the message (POST /api/chat). Nothing is stored here.
 * A refusal is `{ error }` with a plain sentence the composer shows as is.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const user = locals.user
  if (!user) return json({ error: 'Unauthorized' }, { status: 401 })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json({ error: 'Send the file as a multipart form.' }, { status: 400 })
  }
  const files = form.getAll('file').filter((f): f is File => f instanceof File)
  if (files.length !== 1) {
    return json({ error: 'Attach one file per request.' }, { status: 400 })
  }
  const file = files[0]!

  try {
    const attachment = await readAssistantAttachment(
      { complete: dbScopedGatewayComplete },
      { userId: user.id, filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    )
    return json({ attachment })
  } catch (err) {
    if (err instanceof AssistantAttachmentError) {
      return json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
