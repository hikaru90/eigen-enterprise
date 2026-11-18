import type { RequestHandler } from './$types'
import { contactsSharingResponse } from '../../../../../modules/contacts/http'

/**
 * The contacts list's "Share with…" and "Make private" for every selected
 * contact at once (Contribute 9d28020a): one call, `{ changed, skipped }`.
 */
export const POST: RequestHandler = ({ locals, request }) => contactsSharingResponse(locals.user, request)
