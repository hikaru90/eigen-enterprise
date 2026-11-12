import type { RequestHandler } from './$types'
import { contactsExtractResponse } from '../../../../../modules/contacts/http'

/**
 * POST { mode: 'contact' | 'log', text }: "Tell me about them" — the AI's
 * reading of what the person said, as `{ draft }` for the form to prefill.
 * Saves nothing. No company AI provider → 503; the provider failing or an
 * unreadable answer (after retries) → 502.
 */
export const POST: RequestHandler = ({ locals, request }) => contactsExtractResponse(locals.user, request)
