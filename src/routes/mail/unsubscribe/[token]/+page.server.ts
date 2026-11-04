import type { Actions, PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../modules/email/platform/service'

/**
 * /mail/unsubscribe/<token> — the link in every list mail ({{ unsubscribe_url }}).
 * Public; the unguessable token identifies one contact on one list. Opening
 * the page changes nothing (link scanners open links); the button does.
 */
export const load: PageServerLoad = async ({ params }) => {
  const c = await emailPlatform().audience.contactByToken(params.token)
  if (!c) error(404, 'This unsubscribe link is not valid (any more).')
  return { email: c.email, list: c.listName, unsubscribed: c.status === 'unsubscribed' }
}

export const actions: Actions = {
  default: async ({ params }) => {
    const c = await emailPlatform().audience.unsubscribe(params.token)
    if (!c) error(404, 'This unsubscribe link is not valid (any more).')
    return { done: true }
  },
}
