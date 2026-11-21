import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { isMemoryReadOnlyError } from '$lib/server/memory/memory-read-only'
import { setTextFileVisibility } from '$lib/server/text-files/service'

/** The note's Private switch: the UI client of memory.set_text_file_visibility (same service). */
export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) error(401, 'Unauthorized')

  const fileId = event.params.fileId?.trim() ?? ''
  if (!fileId) error(400, 'fileId is required')

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    error(400, 'Invalid JSON')
  }
  const isPrivate =
    typeof body === 'object' && body && 'private' in body && typeof body.private === 'boolean'
      ? body.private
      : undefined
  if (isPrivate === undefined) error(400, 'private (true or false) is required')

  try {
    const result = await setTextFileVisibility(user.id, fileId, isPrivate ? 'private' : 'company')
    if (!result) error(404, 'Text file not found')
    return json(result)
  } catch (err) {
    if (isMemoryReadOnlyError(err)) error(403, err.message)
    throw err
  }
}
