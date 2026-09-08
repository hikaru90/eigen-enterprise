import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { z } from 'zod'
import { jsonError } from '$lib/server/http/api-error'
import { bootstrapKernel } from '../../../../../modules/index'
import { handleContactSubmit } from '../../../../../modules/website/contact'
import { defaultWebsiteStore } from '../../../../../modules/website/store'

export const GET: RequestHandler = async () => {
  error(405, 'Method not allowed')
}

export const POST: RequestHandler = async (event) => {
  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    return jsonError('Invalid JSON', 400)
  }

  try {
    // Fails loud (500) when the kernel is not bootable — no silent degradation.
    const kernel = bootstrapKernel()
    const result = await handleContactSubmit(body, {
      store: defaultWebsiteStore(),
      eventSink: kernel.eventSink,
    })
    return json({ id: result.id }, { status: 201 })
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const field = issue?.path.join('.')
      return jsonError(field ? `${field}: ${issue.message}` : (issue?.message ?? 'Invalid body'), 400)
    }
    throw err
  }
}
