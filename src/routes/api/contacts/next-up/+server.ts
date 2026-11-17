import type { RequestHandler } from './$types'
import { contactsNextUpResponse } from '../../../../../modules/contacts/http'

/**
 * "Next up" on the Contacts and Pipeline pages: the assistant's pick of who to
 * write to next, `{ nextUp }`. GET reuses a fresh pick (a few hours, same day);
 * POST asks the AI again ("Suggest again"). No company AI provider → 503; the
 * provider failing or an unreadable answer (after retries) → 502.
 */
export const GET: RequestHandler = ({ locals }) => contactsNextUpResponse(locals.user, { refresh: false })
export const POST: RequestHandler = ({ locals }) => contactsNextUpResponse(locals.user, { refresh: true })
