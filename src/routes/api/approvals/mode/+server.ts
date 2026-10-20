import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { APPROVAL_MODES, isApprovalMode } from '$lib/kernel/approvals'
import { KERNEL_EVENT_SOURCE } from '$lib/kernel/cloudevents'
import { emitKernelEvent } from '$lib/kernel/events'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { bootstrapKernel } from '../../../../../modules/index'

/**
 * The company-wide approval mode the owner picks under the chat input.
 *   GET → { mode }                     (any signed-in user)
 *   PUT { mode } → { mode }            (owner/admin only; 403 otherwise, 400 bad input)
 * A change emits the audited kernel event `approval.mode_changed`.
 */
export const GET: RequestHandler = async (event) => {
  if (!event.locals.user) return json({ error: 'You must be signed in.' }, { status: 401 })
  return json({ mode: await bootstrapKernel().approvalMode.get() })
}

export const PUT: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) return json({ error: 'You must be signed in.' }, { status: 401 })
  if (!(await isUserAdmin(user.id))) {
    return json({ error: 'Only the owner changes the approval mode.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    return json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const mode = typeof body === 'object' && body !== null ? (body as { mode?: unknown }).mode : undefined
  if (!isApprovalMode(mode)) {
    return json({ error: `mode must be one of: ${APPROVAL_MODES.join(', ')}` }, { status: 400 })
  }

  const kernel = bootstrapKernel()
  const previous = await kernel.approvalMode.get()
  const saved = await kernel.approvalMode.set(mode, user.id)
  await emitKernelEvent(kernel.eventSink, {
    type: 'approval.mode_changed',
    principalId: user.id,
    source: KERNEL_EVENT_SOURCE,
    payload: { from: previous, to: saved },
  })
  return json({ mode: saved })
}
