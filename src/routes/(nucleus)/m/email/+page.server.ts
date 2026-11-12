import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { requireMember } from './access.server'

/**
 * /m/email opens your inbox (Contribute eb674853, plan/email-inbox.md S6). The
 * query (mailbox, folder, mail) carries over; the company-wide pending + sent
 * view moved to Company mail (/m/email/company).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  await requireMember(locals)
  redirect(303, `/m/email/inbox${url.search}`)
}
