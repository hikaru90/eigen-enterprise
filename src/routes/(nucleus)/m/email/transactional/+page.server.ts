import type { PageServerLoad } from './$types'
import { MARKETING_SOURCES } from '../../../../../../modules/email/platform/status'
import { loadOutbox } from '../outbox.server'

/**
 * Email › Transactional mail (was Company mail at /m/email/company until 2026-11-16, Contribute d7080d17): the
 * automatic mail the company sends — system, assistant, API, template, test and opt-in confirmation mail — waiting
 * to go out and sent. Flow mail to lists is marketing mail (Marketing mail › Sent). Owner and admins only.
 */
export const load: PageServerLoad = ({ locals }) =>
  loadOutbox(locals, { excludeSources: MARKETING_SOURCES })
