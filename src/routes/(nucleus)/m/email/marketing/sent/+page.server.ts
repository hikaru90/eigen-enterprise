import type { PageServerLoad } from './$types'
import { MARKETING_SOURCES } from '../../../../../../../modules/email/platform/status'
import { loadOutbox } from '../../outbox.server'

/** Email › Marketing mail › Sent: what the flows have waiting for, and sent to, people on the lists. Owner and admins only. */
export const load: PageServerLoad = ({ locals }) => loadOutbox(locals, { sources: MARKETING_SOURCES })
